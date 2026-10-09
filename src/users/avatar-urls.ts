import { Injectable } from '@nestjs/common';

export type AvatarUrlSigner = (key: string) => Promise<string>;

/**
 * Signs custom profile pictures' stored objects into short-lived URLs. Registered on startup by the
 * storage feature (moments), so the users module doesn't depend on it.
 */
@Injectable()
export class AvatarUrls {
  private signer: AvatarUrlSigner | null = null;

  register(signer: AvatarUrlSigner): void {
    this.signer = signer;
  }

  async sign(key: string): Promise<string | null> {
    return this.signer ? this.signer(key) : null;
  }
}
