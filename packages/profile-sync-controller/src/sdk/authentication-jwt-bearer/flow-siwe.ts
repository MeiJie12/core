import { SiweMessage } from 'siwe';

import { ValidationError } from '../errors';
import { SESSION_LIFETIME_MS } from './constants';
import {
  SIWE_LOGIN_URL,
  authenticate,
  authorizeOIDC,
  getNonce,
} from './services';
import type {
  AuthConfig,
  AuthStorageOptions,
  AuthType,
  IBaseAuth,
  LoginResponse,
  UserProfile,
} from './types';

type JwtBearerAuth_SIWE_Options = {
  storage: AuthStorageOptions;
};

type JwtBearerAuth_SIWE_Signer = {
  address: string;
  chainId: number;
  signMessage: (message: string) => Promise<string>;
  domain: string;
};

export class SIWEJwtBearerAuth implements IBaseAuth {
  #config: AuthConfig;

  #options: JwtBearerAuth_SIWE_Options;

  #signer: JwtBearerAuth_SIWE_Signer | undefined;

  constructor(
    config: AuthConfig & { type: AuthType.SiWE },
    options: JwtBearerAuth_SIWE_Options,
  ) {
    this.#config = config;
    this.#options = options;
  }

  async getAccessToken(): Promise<string> {
    const session = await this.#getAuthSession();
    if (session) {
      return session.token.accessToken;
    }

    const loginResponse = await this.#login();
    return loginResponse.token.accessToken;
  }

  async getUserProfile(): Promise<UserProfile> {
    const session = await this.#getAuthSession();
    if (session) {
      return session.profile;
    }

    const loginResponse = await this.#login();
    return loginResponse.profile;
  }

  async getIdentifier(): Promise<string> {
    this.#assertSigner(this.#signer);
    return this.#signer.address;
  }

  async signMessage(message: string): Promise<string> {
    this.#assertSigner(this.#signer);
    return await this.#signer.signMessage(message);
  }

  prepare(signer: JwtBearerAuth_SIWE_Signer) {
    this.#signer = signer;
  }

  async #getAuthSession(): Promise<LoginResponse | null> {
    const auth = await this.#options.storage.getLoginResponse();
    if (!auth) {
      return null;
    }

    const currentTime = Date.now();
    const sessionAge = currentTime - auth.token.obtainedAt;
    if (sessionAge < SESSION_LIFETIME_MS) {
      return auth;
    }
    return null;
  }

  async #login(): Promise<LoginResponse> {
    this.#assertSigner(this.#signer);

    // Nonce
    const address = await this.getIdentifier();
    const nonceRes = await getNonce(address, this.#config.env);
    const rawMessage = this.#createSiWELoginRawMessage(nonceRes.nonce);
    const signature = await this.signMessage(rawMessage);

    // Authenticate
    const authResponse = await authenticate(
      rawMessage,
      signature,
      this.#config.type,
      this.#config.env,
    );

    // Authorize
    const tokenResponse = await authorizeOIDC(
      authResponse.token,
      this.#config.env,
    );

    // Save
    const result: LoginResponse = {
      profile: authResponse.profile,
      token: tokenResponse,
    };

    await this.#options.storage.setLoginResponse(result);

    return result;
  }

  #createSiWELoginRawMessage(nonce: string): string {
    this.#assertSigner(this.#signer);

    return new SiweMessage({
      domain: this.#signer?.domain,
      address: this.#signer?.address,
      uri: SIWE_LOGIN_URL(this.#config.env),
      version: '1',
      chainId: this.#signer?.chainId,
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
  }

  #assertSigner(
    signer?: JwtBearerAuth_SIWE_Signer,
  ): asserts signer is JwtBearerAuth_SIWE_Signer {
    if (!signer) {
      throw new ValidationError(`you must call 'prepare()' before logging in`);
    }
  }
}