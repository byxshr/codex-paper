#!/usr/bin/env node

import fs from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_DOCKER_CAPTURE) {
  fs.appendFileSync(process.env.FAKE_DOCKER_CAPTURE, `${JSON.stringify(args)}\n`)
}

if (args[0] === 'version') {
  process.stdout.write(JSON.stringify({
    Client: { Version: '29.1.0' },
    Server: { Version: '29.1.0', Os: 'linux', Arch: 'amd64' },
  }))
  process.exit(0)
}

if (args[0] === 'image' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify({
    Id: process.env.FAKE_DOCKER_IMAGE_ID || 'sha256:fake-sandbox-image',
    Config: {
      Labels: {
        'io.codex-paper.sandbox.policy': '1.0.0',
        'io.codex-paper.sandbox.conformance': '1.0.0',
        'io.codex-paper.sandbox.policy-hash': process.env.FAKE_DOCKER_POLICY_HASH || 'wrong',
      },
    },
  }))
  process.exit(0)
}

if (args[0] === 'create') {
  process.stdout.write('fake-container-id\n')
  process.exit(0)
}

if (args[0] === 'start') {
  if (process.env.FAKE_DOCKER_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_DOCKER_DELAY_MS)))
  if (process.env.FAKE_DOCKER_OUTPUT_LIMIT === '1') await new Promise((resolve) => process.stdout.write('x'.repeat(1_100_000), resolve))
  await new Promise((resolve) => process.stdout.write('fake sandbox output\n', resolve))
  process.exit(Number(process.env.FAKE_DOCKER_START_STATUS || 0))
}

if (args[0] === 'inspect') {
  process.stdout.write(JSON.stringify({
    ExitCode: Number(process.env.FAKE_DOCKER_CONTAINER_EXIT || 0),
    OOMKilled: process.env.FAKE_DOCKER_OOM === '1',
  }))
  process.exit(0)
}

if (args[0] === 'cp') {
  const destination = args.at(-1)
  const payload = process.env.FAKE_DOCKER_RESOURCE_JSON || JSON.stringify({ wallTimeMs: 2, userCpuMs: 1, systemCpuMs: 0.5, maxRssKiB: 4096, status: 0 })
  fs.writeFileSync(destination, payload)
  process.exit(0)
}

if (args[0] === 'rm' && process.env.FAKE_DOCKER_RM_FAIL === '1') {
  process.stderr.write('simulated container cleanup failure\n')
  process.exit(1)
}

if (['kill', 'rm'].includes(args[0])) process.exit(0)
if (args[0] === 'build') process.exit(0)

process.stderr.write(`unsupported fake docker command: ${args.join(' ')}\n`)
process.exit(1)
