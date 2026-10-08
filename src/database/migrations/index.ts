import { CreateTrips1759449600000 } from './1759449600000-create-trips.js';
import { CreateSuggestedEvents1759536000000 } from './1759536000000-create-suggested-events.js';
import { CreateUsers1760000000000 } from './1760000000000-create-users.js';
import { CreateRefreshTokens1760000100000 } from './1760000100000-create-refresh-tokens.js';
import { AppTrips1760100000000 } from './1760100000000-app-trips.js';
import { CreateTripInvites1760186400000 } from './1760186400000-create-trip-invites.js';
import { AddUserForeignKeys1760190000000 } from './1760190000000-add-user-foreign-keys.js';
import { CreateTripRemovals1760200000000 } from './1760200000000-create-trip-removals.js';
import { OneOwnerPerTrip1760200100000 } from './1760200100000-one-owner-per-trip.js';
import { CreateAiTables1760400000000 } from './1760400000000-create-ai-tables.js';
import { AddAiMessageAttempts1760400100000 } from './1760400100000-add-ai-message-attempts.js';
import { AddAiMessageReplyingUntil1760400200000 } from './1760400200000-add-ai-message-replying-until.js';
import { AddItinerary1760500000000 } from './1760500000000-add-itinerary.js';
import { AddBilling1760600000000 } from './1760600000000-add-billing.js';

// Register every migration here, in order.
export const migrations = [
  CreateTrips1759449600000,
  CreateSuggestedEvents1759536000000,
  CreateUsers1760000000000,
  CreateRefreshTokens1760000100000,
  AppTrips1760100000000,
  CreateTripInvites1760186400000,
  AddUserForeignKeys1760190000000,
  CreateTripRemovals1760200000000,
  OneOwnerPerTrip1760200100000,
  CreateAiTables1760400000000,
  AddAiMessageAttempts1760400100000,
  AddAiMessageReplyingUntil1760400200000,
  AddItinerary1760500000000,
  AddBilling1760600000000,
];
