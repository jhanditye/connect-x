// The real scoring dependencies for the reducer (kept apart so reducer tests can inject fakes).

import { buildCoachingPlan } from '../coach/coach';
import { compareToProfile } from '../coach/compare';
import { measuredProfile } from '../coach/measured';
import { SINGERS } from '../coach/profiles';
import { compareToReference, profileFromReference, referenceUsability } from '../coach/reference';
import type { ScoringDeps } from './reducer';

export const scoringDeps: ScoringDeps = {
  builtins: SINGERS,
  compare: compareToProfile,
  plan: buildCoachingPlan,
  profileFromReference,
  referenceUsability,
  compareToReference,
  measuredProfile,
};
