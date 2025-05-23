import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { TokenSet } from 'openid-client';
import yargs from 'yargs';

import { Api } from '@neondatabase/api-client';

import { auth, refreshToken } from '../auth.js';
import { log } from '../log.js';
import { getApiClient } from '../api.js';
import { isCi } from '../env.js';
import { CREDENTIALS_FILE } from '../config.js';

type AuthProps = {
  _: (string | number)[];
  configDir: string;
  oauthHost: string;
  apiHost: string;
  clientId: string;
  forceAuth: boolean;
};

export const command = 'auth';
export const aliases = ['login'];
export const describe = 'Authenticate';
export const builder = (yargs: yargs.Argv) =>
  yargs.option('context-file', {
    hidden: true,
  });
export const handler = async (args: AuthProps) => {
  await authFlow(args);
};

export const authFlow = async ({
  configDir,
  oauthHost,
  clientId,
  apiHost,
  forceAuth,
}: AuthProps) => {
  if (!forceAuth && isCi()) {
    throw new Error('Cannot run interactive auth in CI');
  }
  const tokenSet = await auth({
    oauthHost: oauthHost,
    clientId: clientId,
  });

  const credentialsPath = join(configDir, CREDENTIALS_FILE);
  await preserveCredentials(
    credentialsPath,
    tokenSet,
    getApiClient({
      apiKey: tokenSet.access_token || '',
      apiHost,
    }),
  );
  log.info('Auth complete');
  return tokenSet.access_token || '';
};

const preserveCredentials = async (
  path: string,
  credentials: TokenSet,
  apiClient: Api<unknown>,
) => {
  const {
    data: { id },
  } = await apiClient.getCurrentUserInfo();
  const contents = JSON.stringify({
    ...credentials,
    user_id: id,
  });
  // correctly sets needed permissions for the credentials file
  writeFileSync(path, contents, {
    mode: 0o700,
  });
  log.info('Saved credentials to %s', path);
  log.debug('Credentials MD5 hash: %s', md5hash(contents));
};

export const ensureAuth = async (
  props: AuthProps & {
    apiKey: string;
    apiClient: Api<unknown>;
    help: boolean;
  },
) => {
  if (props._.length === 0 || props.help) {
    return;
  }
  if (props.apiKey || props._[0] === 'auth') {
    if (props.apiKey) {
      log.debug('using an API key to authorize requests');
    }
    props.apiClient = getApiClient({
      apiKey: props.apiKey,
      apiHost: props.apiHost,
    });
    return;
  }
  const credentialsPath = join(props.configDir, CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    log.debug('Trying to read credentials from %s', credentialsPath);
    try {
      const contents = readFileSync(credentialsPath, 'utf8');
      log.debug('Credentials MD5 hash: %s', md5hash(contents));
      const tokenSet = new TokenSet(JSON.parse(contents));
      if (tokenSet.expired()) {
        log.debug('Using refresh token to update access token');
        let refreshedTokenSet;
        try {
          refreshedTokenSet = await refreshToken(
            {
              oauthHost: props.oauthHost,
              clientId: props.clientId,
            },
            tokenSet,
          );
        } catch (err: unknown) {
          const typedErr = err && err instanceof Error ? err : undefined;
          log.error('Failed to refresh token\n%s', typedErr?.message);
          log.info('Starting auth flow');
          throw new Error('AUTH_REFRESH_FAILED');
        }

        props.apiKey = refreshedTokenSet.access_token || 'UNKNOWN';
        props.apiClient = getApiClient({
          apiKey: props.apiKey,
          apiHost: props.apiHost,
        });
        await preserveCredentials(
          credentialsPath,
          refreshedTokenSet,
          props.apiClient,
        );
        return;
      }
      const token = tokenSet.access_token || 'UNKNOWN';

      props.apiKey = token;
      props.apiClient = getApiClient({
        apiKey: props.apiKey,
        apiHost: props.apiHost,
      });
      return;
    } catch (e) {
      if (
        (e instanceof Error && e.message.includes('AUTH_REFRESH_FAILED')) ||
        (e as { code: string }).code === 'ENOENT'
      ) {
        props.apiKey = await authFlow(props);
      } else {
        // throw for any other errors
        throw e;
      }
    }
  } else {
    log.debug(
      'Credentials file %s does not exist, starting authentication',
      credentialsPath,
    );
    props.apiKey = await authFlow(props);
  }
  props.apiClient = getApiClient({
    apiKey: props.apiKey,
    apiHost: props.apiHost,
  });
};

const md5hash = (s: string) => createHash('md5').update(s).digest('hex');
