#!/usr/bin/env python3
"""
Extract useful visual assets from PDF files using PyMuPDF.

The extractor has two paths:
- embedded bitmap extraction for PDFs that contain real image objects
- vector fallback for paper figures/tables/algorithms drawn as PDF text/lines

Usage: python extract-images.py <pdf-path> <output-dir>
"""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF


MIN_EMBED_WIDTH = 240
MIN_EMBED_HEIGHT = 160
MIN_EMBED_PIXELS = 80_000
MIN_CROP_HEIGHT = 80
VECTOR_FALLBACK_DPI = 216
MAX_VECTOR_CANDIDATES = 8
MIN_DRAWING_WIDTH = 6
MIN_DRAWING_HEIGHT = 6
MIN_DRAWING_AREA = 36
DRAWING_CLUSTER_GAP = 24
FIGURE_TEXT_TOP_PADDING = 30
FIGURE_TEXT_BOTTOM_PADDING = 30
FIGURE_MAX_CAPTION_DISTANCE = 320
CAPTION_MAX_HEIGHT = 145
CAPTION_LINE_GAP = 8
CONTENT_PADDING_X = 8
CONTENT_PADDING_Y = 10
TRIM_THRESHOLD = 246
TRIM_MARGIN_PX = 18

ANCHOR_RE = re.compile(
    r"^\s*(?P<kind>Figure|Fig\.|Table|Algorithm)\s+(?P<number>[A-Za-z0-9.]+)",
    re.IGNORECASE,
)

SECTION_HEADING_RE = re.compile(r"^\s*\d+\.?\s*[A-Z][A-Z\s\-:]+$")
RUNNING_HEADER_RE = re.compile(
    r"(?:published as a conference paper|preprint|under review|conference paper|workshop)",
    re.IGNORECASE,
)


def safe_slug(value):
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def is_useful_embedded_image(width, height):
    if width < MIN_EMBED_WIDTH or height < MIN_EMBED_HEIGHT:
        return False
    if width * height < MIN_EMBED_PIXELS:
        return False
    return True


def save_pixmap(page, filepath, clip=None, dpi=VECTOR_FALLBACK_DPI):
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)
    pix.save(str(filepath))
    return pix.width, pix.height


def trim_clip_to_content(page, clip, dpi=VECTOR_FALLBACK_DPI):
    """Return a tighter clip by scanning rendered non-white pixels."""
    if clip is None:
        return clip

    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)
    components = pix.n
    samples = pix.samples
    width = pix.width
    height = pix.height
    stride = width * components

    min_x = width
    min_y = height
    max_x = -1
    max_y = -1

    for y in range(height):
        row = y * stride
        for x in range(width):
            offset = row + x * components
            pixel = samples[offset : offset + min(components, 3)]
            if any(channel < TRIM_THRESHOLD for channel in pixel):
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x < min_x or max_y < min_y:
        return clip

    min_x = max(0, min_x - TRIM_MARGIN_PX)
    min_y = max(0, min_y - TRIM_MARGIN_PX)
    max_x = min(width - 1, max_x + TRIM_MARGIN_PX)
    max_y = min(height - 1, max_y + TRIM_MARGIN_PX)

    trimmed = fitz.Rect(
        clip.x0 + min_x / zoom,
        clip.y0 + min_y / zoom,
        clip.x0 + (max_x + 1) / zoom,
        clip.y0 + (max_y + 1) / zoom,
    )

    if trimmed.width < 0.45 * clip.width or trimmed.height < 0.45 * clip.height:
        return trimmed
    if trimmed.width < clip.width - 4 or trimmed.height < clip.height - 4:
        return trimmed
    return clip


def union_rect(rects):
    output = fitz.Rect(rects[0])
    for rect in rects[1:]:
        output |= fitz.Rect(rect)
    return output


def clamp_rect(rect, page_rect):
    rect = fitz.Rect(rect)
    rect.x0 = max(page_rect.x0, rect.x0)
    rect.y0 = max(page_rect.y0, rect.y0)
    rect.x1 = min(page_rect.x1, rect.x1)
    rect.y1 = min(page_rect.y1, rect.y1)
    return rect


def rect_is_valid(rect):
    return rect.width > 80 and rect.height > MIN_CROP_HEIGHT


def rect_area(rect):
    return max(0, rect.width) * max(0, rect.height)


def expand_rect(rect, x_padding=CONTENT_PADDING_X, y_padding=CONTENT_PADDING_Y):
    return fitz.Rect(
        rect.x0 - x_padding,
        rect.y0 - y_padding,
        rect.x1 + x_padding,
        rect.y1 + y_padding,
    )


def horizontal_overlap_ratio(a, b):
    overlap = max(0, min(a.x1, b.x1) - max(a.x0, b.x0))
    return overlap / max(1, min(a.width, b.width))


def collect_text_lines(page):
    lines = []
    page_dict = page.get_text("dict")

    for block in page_dict.get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue

            text = " ".join(span.get("text", "") for span in spans).strip()
            if not text:
                continue

            bbox_spans = [span["bbox"] for span in spans if "bbox" in span]
            if not bbox_spans:
                continue

            rect = union_rect(bbox_spans)
            max_size = max(float(span.get("size") or 0) for span in spans)
            lines.append({"text": text, "rect": rect, "max_size": max_size})

    return lines


def is_section_heading(line):
    text = re.sub(r"\s+", " ", line["text"]).strip()
    letters = re.sub(r"[^A-Za-z]", "", text)
    if text.isdigit():
        return True
    if line.get("max_size", 0) >= 11.5 and SECTION_HEADING_RE.match(text):
        return True
    return bool(letters) and letters.upper() == letters and len(letters) >= 6


def is_anchor_line(line):
    return ANCHOR_RE.search(line["text"]) is not None


def is_running_header(line):
    return RUNNING_HEADER_RE.search(line["text"]) is not None


def useful_drawing_rects(page):
    rects = []
    for drawing in page.get_drawings():
        rect = drawing.get("rect")
        if not rect:
            continue
        rect = clamp_rect(fitz.Rect(rect), page.rect)
        if rect.width < MIN_DRAWING_WIDTH or rect.height < MIN_DRAWING_HEIGHT:
            continue
        if rect_area(rect) < MIN_DRAWING_AREA:
            continue
        aspect = min(rect.width, rect.height) / max(rect.width, rect.height)
        if aspect < 0.05 and max(rect.width, rect.height) > 120:
            continue
        if rect.y0 < page.rect.y0 + 45 and rect.height < 40:
            continue
        rects.append(rect)
    return rects


def cluster_rects_vertically(rects, gap=DRAWING_CLUSTER_GAP):
    clusters = []
    current = []
    current_union = None

    for rect in sorted(rects, key=lambda item: (item.y0, item.x0)):
        if current_union is None or rect.y0 <= current_union.y1 + gap:
            current.append(rect)
            current_union = fitz.Rect(rect) if current_union is None else current_union | rect
            continue

        clusters.append({"rects": current, "union": current_union})
        current = [rect]
        current_union = fitz.Rect(rect)

    if current:
        clusters.append({"rects": current, "union": current_union})

    return clusters


def nearby_text_for_visual(page, visual_rect, anchor_rect):
    lines = collect_text_lines(page)
    top = visual_rect.y0 - FIGURE_TEXT_TOP_PADDING
    bottom = min(anchor_rect.y0 - 1, visual_rect.y1 + FIGURE_TEXT_BOTTOM_PADDING)
    candidates = []

    for line in lines:
        rect = line["rect"]
        if rect.y0 < top or rect.y1 > bottom:
            continue
        if is_anchor_line(line) or is_section_heading(line) or is_running_header(line):
            continue
        if horizontal_overlap_ratio(rect, visual_rect) < 0.08 and horizontal_overlap_ratio(rect, anchor_rect) < 0.08:
            continue
        candidates.append(rect)

    return candidates


def matches_anchor_column(page, rect, anchor_rect):
    if anchor_rect.width >= page.rect.width * 0.55:
        return horizontal_overlap_ratio(rect, anchor_rect) > 0.12 or abs(rect.x0 - anchor_rect.x0) < 28

    margin = 18
    column = fitz.Rect(anchor_rect.x0 - margin, page.rect.y0, anchor_rect.x1 + margin, page.rect.y1)
    center_x = (rect.x0 + rect.x1) / 2
    return column.x0 <= center_x <= column.x1 or horizontal_overlap_ratio(rect, column) > 0.25


def matches_caption_column(page, rect, anchor_rect):
    if anchor_rect.width >= page.rect.width * 0.55:
        return abs(rect.x0 - anchor_rect.x0) < 32 or horizontal_overlap_ratio(rect, anchor_rect) > 0.2
    return abs(rect.x0 - anchor_rect.x0) < 45


def caption_rects_for_anchor(page, anchor):
    anchor_rect = anchor["rect"]
    caption_rects = []
    previous_bottom = None

    for line in sorted(collect_text_lines(page), key=lambda item: (item["rect"].y0, item["rect"].x0)):
        rect = line["rect"]
        if rect.y0 < anchor_rect.y0 - 2:
            continue
        if rect.y0 > anchor_rect.y0 + CAPTION_MAX_HEIGHT:
            break
        if not matches_caption_column(page, rect, anchor_rect):
            continue
        if caption_rects and rect.y0 - previous_bottom > CAPTION_LINE_GAP:
            break
        if caption_rects and is_anchor_line(line):
            break

        caption_rects.append(rect)
        previous_bottom = rect.y1

    return caption_rects


def caption_bottom_limit(page, caption_rects):
    if not caption_rects:
        return None

    last_bottom = max(rect.y1 for rect in caption_rects)
    limit = last_bottom + 4

    for line in collect_text_lines(page):
        rect = line["rect"]
        if rect.y0 <= last_bottom + 0.5:
            continue
        if rect.y0 > last_bottom + 18:
            continue
        limit = min(limit, rect.y0 - 2)

    return limit


def cluster_visual_rect_for_anchor(page, cluster, anchor_rect):
    if anchor_rect.width >= page.rect.width * 0.55:
        return cluster["union"]

    margin = 36
    column = fitz.Rect(anchor_rect.x0 - margin, page.rect.y0, anchor_rect.x1 + margin, page.rect.y1)
    filtered = [
        rect
        for rect in cluster["rects"]
        if (
            column.x0 <= (rect.x0 + rect.x1) / 2 <= column.x1
            or horizontal_overlap_ratio(rect, column) > 0.4
        )
    ]
    if not filtered:
        return cluster["union"]

    visual_rect = union_rect(filtered)
    if visual_rect.width > 70 and visual_rect.height > 20:
        return visual_rect
    return cluster["union"]


def running_header_bottom(page):
    bottoms = [
        line["rect"].y1
        for line in collect_text_lines(page)
        if line["rect"].y0 < page.rect.height * 0.12 and is_running_header(line)
    ]
    return max(bottoms) if bottoms else None


def avoid_running_header(page, clip, anchor_rect):
    header_bottom = running_header_bottom(page)
    if header_bottom is None:
        return clip
    if anchor_rect.y0 - header_bottom > 80 and clip.y0 < header_bottom + 18:
        clip.y0 = header_bottom + 18
    return clip


def content_aware_figure_crop(page, anchor):
    anchor_rect = anchor["rect"]
    drawing_rects = [
        rect
        for rect in useful_drawing_rects(page)
        if rect.y1 <= anchor_rect.y0 - 3 and anchor_rect.y0 - rect.y1 <= FIGURE_MAX_CAPTION_DISTANCE
    ]
    clusters = cluster_rects_vertically(drawing_rects)
    clusters = [
        cluster
        for cluster in clusters
        if cluster["union"].width > 80 and cluster["union"].height > 20
    ]

    if clusters:
        cluster = min(clusters, key=lambda item: anchor_rect.y0 - item["union"].y1)
        visual_rect = cluster_visual_rect_for_anchor(page, cluster, anchor_rect)
        caption_rects = caption_rects_for_anchor(page, anchor)
        rects = [
            visual_rect,
            *nearby_text_for_visual(page, visual_rect, anchor_rect),
            *caption_rects,
        ]
        clip = expand_rect(union_rect(rects))
        clip = avoid_running_header(page, clip, anchor_rect)
        bottom_limit = caption_bottom_limit(page, caption_rects)
        if bottom_limit is not None:
            clip.y1 = min(clip.y1, bottom_limit)
        return clamp_rect(clip, page.rect)

    return text_block_above_anchor_crop(page, anchor)


def text_block_above_anchor_crop(page, anchor):
    anchor_rect = anchor["rect"]
    lines = [
        line
        for line in collect_text_lines(page)
        if line["rect"].y1 < anchor_rect.y0 - 4
        and anchor_rect.y0 - line["rect"].y1 <= FIGURE_MAX_CAPTION_DISTANCE
        and not is_anchor_line(line)
        and not is_section_heading(line)
    ]
    lines = sorted(lines, key=lambda line: line["rect"].y0, reverse=True)
    if not lines:
        return None

    selected = []
    previous_top = None
    for line in lines:
        rect = line["rect"]
        if previous_top is not None and previous_top - rect.y1 > 22:
            break
        selected.append(rect)
        previous_top = rect.y0

    if not selected:
        return None

    clip = expand_rect(union_rect(selected))
    clip = avoid_running_header(page, clip, anchor_rect)
    caption_rects = caption_rects_for_anchor(page, anchor)
    if caption_rects:
        clip = union_rect([clip, *caption_rects])
        clip = expand_rect(clip)
        bottom_limit = caption_bottom_limit(page, caption_rects)
        if bottom_limit is not None:
            clip.y1 = min(clip.y1, bottom_limit)
    return clamp_rect(clip, page.rect)


def algorithm_crop(page, anchor):
    anchor_rect = anchor["rect"]
    lines = [
        line
        for line in collect_text_lines(page)
        if line["rect"].y0 >= anchor_rect.y0 - 6
        and line["rect"].y0 <= anchor_rect.y0 + 280
        and not is_section_heading(line)
    ]
    lines = sorted(lines, key=lambda line: line["rect"].y0)
    selected = []
    previous_bottom = None

    for line in lines:
        rect = line["rect"]
        if previous_bottom is not None and rect.y0 - previous_bottom > 20:
            break
        selected.append(rect)
        previous_bottom = rect.y1

    if not selected:
        return None

    clip = union_rect(selected)
    drawing_rects = [
        rect
        for rect in useful_drawing_rects(page)
        if rect.y0 >= clip.y0 - 8 and rect.y1 <= clip.y1 + 8 and horizontal_overlap_ratio(rect, clip) > 0.2
    ]
    if drawing_rects:
        clip = union_rect([clip, *drawing_rects])
    return clamp_rect(expand_rect(clip, 6, 6), page.rect)


def extract_embedded_images(doc, output_path):
    extracted = []
    page_images = {}
    seen_hashes = set()

    for page_num, page in enumerate(doc, start=1):
        image_list = page.get_images(full=True)
        if image_list:
            page_images[page_num] = len(image_list)
            print(f"Page {page_num}: found {len(image_list)} embedded image object(s)")

        for img_index, img in enumerate(image_list, start=1):
            xref = img[0]
            base_image = doc.extract_image(xref)
            if not base_image:
                continue

            width = int(base_image.get("width") or 0)
            height = int(base_image.get("height") or 0)
            if not is_useful_embedded_image(width, height):
                print(f"  skip small/low-information image p{page_num}#{img_index}: {width}x{height}")
                continue

            image_bytes = base_image["image"]
            digest = hashlib.sha1(image_bytes).hexdigest()
            if digest in seen_hashes:
                print(f"  skip duplicate image p{page_num}#{img_index}: {width}x{height}")
                continue
            seen_hashes.add(digest)

            ext = base_image.get("ext") or "png"
            filename = f"page_{page_num:03d}_image_{img_index:02d}_{width}x{height}.{ext}"
            filepath = output_path / filename
            with open(filepath, "wb") as f:
                f.write(image_bytes)

            extracted.append(
                {
                    "path": str(filepath),
                    "kind": "embedded-image",
                    "page": page_num,
                    "width": width,
                    "height": height,
                }
            )

    return extracted, page_images


def find_text_anchors(page):
    anchors = []
    page_dict = page.get_text("dict")

    for block in page_dict.get("blocks", []):
        line_items = block.get("lines", [])
        for line in line_items:
            spans = line.get("spans", [])
            if not spans:
                continue

            text = " ".join(span.get("text", "") for span in spans).strip()
            if not text:
                continue

            match = ANCHOR_RE.search(text)
            if not match:
                continue

            rect = union_rect([span["bbox"] for span in spans if "bbox" in span])
            kind = match.group("kind").replace(".", "").lower()
            number = match.group("number").rstrip(".")
            anchors.append(
                {
                    "kind": "figure" if kind == "fig" else kind,
                    "number": number,
                    "text": text,
                    "rect": rect,
                }
            )

    return anchors


def crop_for_anchor(page, anchor):
    page_rect = page.rect
    rect = anchor["rect"]
    kind = anchor["kind"]

    if kind == "algorithm":
        clip = algorithm_crop(page, anchor)
    elif kind in {"figure", "table"}:
        clip = content_aware_figure_crop(page, anchor)
    else:
        clip = fitz.Rect(page_rect.x0 + 35, rect.y0 - 180, page_rect.x1 - 35, rect.y1 + 90)

    if clip is None:
        return None

    clip = clamp_rect(clip, page_rect)
    if not rect_is_valid(clip):
        return None
    return trim_clip_to_content(page, clip)


def extract_vector_candidates(doc, output_path):
    candidates = []
    seen = set()

    for page_num, page in enumerate(doc, start=1):
        for anchor in find_text_anchors(page):
            key = (page_num, anchor["kind"], anchor["number"])
            if key in seen:
                continue
            seen.add(key)

            clip = crop_for_anchor(page, anchor)
            label = f"{anchor['kind']}_{safe_slug(anchor['number'])}"

            if clip and rect_is_valid(clip):
                filename = f"{label}_page_{page_num:03d}_crop.png"
                filepath = output_path / filename
                width, height = save_pixmap(page, filepath, clip=clip)
                candidates.append(
                    {
                        "path": str(filepath),
                        "kind": "vector-crop-candidate",
                        "page": page_num,
                        "anchor": f"{anchor['kind'].title()} {anchor['number']}",
                        "width": width,
                        "height": height,
                        "navigation_only": False,
                    }
                )
                print(f"  vector crop candidate: {filename} ({width}x{height})")
            else:
                filename = f"navigation_only_page_{page_num:03d}_{label}_preview.png"
                filepath = output_path / filename
                width, height = save_pixmap(page, filepath)
                candidates.append(
                    {
                        "path": str(filepath),
                        "kind": "navigation-only-page-preview",
                        "page": page_num,
                        "anchor": f"{anchor['kind'].title()} {anchor['number']}",
                        "width": width,
                        "height": height,
                        "navigation_only": True,
                    }
                )
                print(f"  navigation-only preview: {filename} ({width}x{height})")

            if len(candidates) >= MAX_VECTOR_CANDIDATES:
                return candidates

    if not candidates and len(doc) > 0:
        # Last resort: one high-DPI navigation preview, explicitly named as such.
        page = doc[0]
        filename = "navigation_only_page_001_preview.png"
        filepath = output_path / filename
        width, height = save_pixmap(page, filepath)
        candidates.append(
            {
                "path": str(filepath),
                "kind": "navigation-only-page-preview",
                "page": 1,
                "anchor": "none",
                "width": width,
                "height": height,
                "navigation_only": True,
            }
        )
        print(f"  fallback navigation-only preview: {filename} ({width}x{height})")

    return candidates


def extract_images(pdf_path, output_dir):
    """
    Extract useful visual assets from a PDF file.

    Returns a list of extracted file paths. The terminal log includes kind/page
    metadata so the study author can avoid treating page previews as body figures.
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    print(f"Processing PDF: {pdf_path}")
    print(f"Total pages: {len(doc)}")

    embedded, page_images = extract_embedded_images(doc, output_path)
    extracted = embedded

    if len(embedded) < 3:
        print("Few useful embedded images found; entering vector/text-anchor fallback.")
        extracted.extend(extract_vector_candidates(doc, output_path))

    doc.close()

    print("\nSummary:")
    print(f"  Total useful assets extracted: {len(extracted)}")
    print(f"  Embedded image objects by page: {page_images}")
    print("  Asset metadata:")
    for item in extracted:
        print(f"    - {item['kind']} page={item['page']} size={item['width']}x{item['height']} path={item['path']}")

    return [item["path"] for item in extracted]


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python extract-images.py <pdf-path> <output-dir>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]

    if not os.path.exists(pdf_path):
        print(f"Error: PDF file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        extracted = extract_images(pdf_path, output_dir)
        print(json.dumps(extracted))
    except Exception as e:
        print(f"Error extracting images: {e}", file=sys.stderr)
        sys.exit(1)
