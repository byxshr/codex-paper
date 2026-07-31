import fs from 'node:fs';
import {
  buildProvenanceDraft,
  collectRuntimeAttestation
} from '../../../../../src/shared/generation-provenance.mjs';

export function writeTestProvenanceDraft({
  workspaceDir,
  workspaceId,
  paperKey,
  paperId,
  sourceRevisionId,
  generationId,
  now = new Date(0).toISOString()
}) {
  const sourceSha256 = sourceRevisionId.replace(/^sha256:/, '');
  const runtime = collectRuntimeAttestation(process.env, {
    node: '22.23.1',
    npm: '10.9.8',
    python: {
      version: '3.11.15',
      implementation: 'CPython',
      pyMuPDF: '1.28.0'
    }
  });
  const identity = {
    schemaVersion: '2.0.0',
    paperId,
    sourceRevisionId,
    generationId,
    source: { sha256: sourceSha256 },
    canonical: {
      resolution: 'source_fallback',
      primary: null,
      aliases: [],
      candidates: [],
      diagnostics: []
    },
    generation: {
      inputs: {
        workflow: 'study',
        pluginBaseVersion: '2.0.0',
        evidenceSchemaVersion: '2.0.0',
        factsSchemaVersion: '2.1.0',
        reasoningSchemaVersion: '2.0.0',
        authoringEngine: {
          provider: 'unavailable',
          model: 'unavailable',
          evidence: 'unavailable'
        }
      }
    },
    provenance: {
      pluginBuildVersion: '2.0.0+codex.test'
    }
  };
  const draft = buildProvenanceDraft({
    workspaceId,
    paperKey,
    sourceRevisionId,
    generationId,
    identity,
    runtime,
    source: {
      kind: 'local_file',
      filename: 'synthetic.pdf',
      bytes: 64,
      acquiredAt: now
    },
    now
  });
  fs.writeFileSync(
    `${workspaceDir}/provenance-draft.json`,
    `${JSON.stringify(draft, null, 2)}\n`
  );
  return draft;
}
