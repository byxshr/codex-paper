export const PAPER_TYPES = [
  'empirical',
  'theoretical',
  'architecture',
  'system',
  'benchmark',
  'survey',
  'post-training',
  'position',
  'other'
];

export const PROFILE_RULES = {
  empirical: {
    validationKinds: ['experiment', 'ablation', 'benchmark'],
    requiredEvidence: ['data split', 'metrics', 'baselines', 'main result', 'variance or seeds'],
    artifactTypes: ['code', 'simulation', 'numerical_sanity_check']
  },
  theoretical: {
    validationKinds: ['theorem', 'proof', 'simulation', 'argument'],
    requiredEvidence: ['assumptions', 'theorem statements', 'proof dependencies', 'boundary conditions'],
    artifactTypes: ['symbolic_derivation', 'numerical_sanity_check', 'simulation']
  },
  architecture: {
    validationKinds: ['ablation', 'benchmark', 'experiment'],
    requiredEvidence: ['component description', 'compute budget', 'parameter budget', 'ablation'],
    artifactTypes: ['code', 'interactive_demo', 'simulation']
  },
  system: {
    validationKinds: ['benchmark', 'case_study', 'simulation'],
    requiredEvidence: ['hardware', 'latency', 'throughput', 'resource cost', 'workload'],
    artifactTypes: ['simulation', 'numerical_sanity_check', 'interactive_demo']
  },
  benchmark: {
    validationKinds: ['benchmark', 'user_study', 'argument'],
    requiredEvidence: ['construct validity', 'annotation quality', 'coverage', 'metric sensitivity'],
    artifactTypes: ['taxonomy_explorer', 'simulation', 'numerical_sanity_check']
  },
  survey: {
    validationKinds: ['survey_synthesis', 'argument'],
    requiredEvidence: ['inclusion criteria', 'taxonomy', 'coverage', 'omitted directions'],
    artifactTypes: ['taxonomy_explorer', 'argument_map']
  },
  'post-training': {
    validationKinds: ['experiment', 'ablation', 'benchmark'],
    requiredEvidence: ['data source', 'reward signal', 'sampling strategy', 'baseline budget'],
    artifactTypes: ['code', 'simulation', 'numerical_sanity_check']
  },
  position: {
    validationKinds: ['argument', 'case_study'],
    requiredEvidence: ['argument chain', 'counterargument', 'falsifiable prediction'],
    artifactTypes: ['argument_map', 'interactive_demo']
  },
  other: {
    validationKinds: ['other', 'argument', 'case_study'],
    requiredEvidence: ['problem', 'method or argument', 'supporting evidence', 'limitations'],
    artifactTypes: ['code', 'interactive_demo', 'argument_map']
  }
};

export const REQUIRED_REFLECTION_HEADINGS = [
  '最弱假设',
  '最强反例',
  '非增量后续研究'
];

export function profileForType(paperType) {
  return PROFILE_RULES[paperType] || PROFILE_RULES.other;
}
