import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const SCOPES = [DRIVE_READONLY_SCOPE, DRIVE_FILE_SCOPE];

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

function buildGoogleProvider(forceConsent: boolean): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  SCOPES.forEach((scope) => provider.addScope(scope));
  provider.setCustomParameters({
    prompt: forceConsent ? 'consent select_account' : 'select_account',
    include_granted_scopes: 'true',
  });
  return provider;
}

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export interface TokenScopeCheck {
  hasDriveRead: boolean;
  hasDriveWrite: boolean;
  grantedScopes: string[];
}

export const verifyGrantedScopes = async (
  accessToken: string
): Promise<TokenScopeCheck | null> => {
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { scope?: string };
    const grantedScopes = (data.scope || '').split(/\s+/).filter(Boolean);
    const hasDriveRead =
      grantedScopes.includes(DRIVE_READONLY_SCOPE) ||
      grantedScopes.includes('https://www.googleapis.com/auth/drive');
    const hasDriveWrite =
      grantedScopes.includes(DRIVE_FILE_SCOPE) ||
      grantedScopes.includes('https://www.googleapis.com/auth/drive');
    return { hasDriveRead, hasDriveWrite, grantedScopes };
  } catch {
    return null;
  }
};

export const googleSignIn = async (
  options: { forceConsent?: boolean } = { forceConsent: true }
): Promise<{
  user: User;
  accessToken: string;
  scopeCheck: TokenScopeCheck | null;
}> => {
  try {
    isSigningIn = true;
    const provider = buildGoogleProvider(options.forceConsent !== false);
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('未能从 Google 身份验证获取到访问令牌，请重新授权。');
    }
    cachedAccessToken = credential.accessToken;
    const scopeCheck = await verifyGrantedScopes(cachedAccessToken);
    return { user: result.user, accessToken: cachedAccessToken, scopeCheck };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async (): Promise<void> => {
  await auth.signOut();
  cachedAccessToken = null;
};
