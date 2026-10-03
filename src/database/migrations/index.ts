import { CreateTrips1759449600000 } from './1759449600000-create-trips.js';
import { CreateSuggestedEvents1759536000000 } from './1759536000000-create-suggested-events.js';
import { CreateUsers1760000000000 } from './1760000000000-create-users.js';
import { CreateRefreshTokens1760000100000 } from './1760000100000-create-refresh-tokens.js';

// Register every migration here, in order.
export const migrations = [
  CreateTrips1759449600000,
  CreateSuggestedEvents1759536000000,
  CreateUsers1760000000000,
  CreateRefreshTokens1760000100000,
];
