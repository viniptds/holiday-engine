import { CreateTrips1759449600000 } from './1759449600000-create-trips.js';
import { CreateSuggestedEvents1759536000000 } from './1759536000000-create-suggested-events.js';
import { CreateUsers1760000000000 } from './1760000000000-create-users.js';
import { CreateRefreshTokens1760000100000 } from './1760000100000-create-refresh-tokens.js';
import { AppTrips1760100000000 } from './1760100000000-app-trips.js';
import { CreateTripInvites1760186400000 } from './1760186400000-create-trip-invites.js';
import { AddUserForeignKeys1760190000000 } from './1760190000000-add-user-foreign-keys.js';
import { CreateAiTables1760400000000 } from './1760400000000-create-ai-tables.js';
import { AddAiMessageAttempts1760400100000 } from './1760400100000-add-ai-message-attempts.js';

// Register every migration here, in order.
export const migrations = [
  CreateTrips1759449600000,
  CreateSuggestedEvents1759536000000,
  CreateUsers1760000000000,
  CreateRefreshTokens1760000100000,
  AppTrips1760100000000,
  CreateTripInvites1760186400000,
  AddUserForeignKeys1760190000000,
  CreateAiTables1760400000000,
  AddAiMessageAttempts1760400100000,
];
