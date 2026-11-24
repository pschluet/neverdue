import { Amplify } from 'aws-amplify';
import {
  confirmSignIn,
  fetchUserAttributes,
  getCurrentUser,
  signIn,
  signOut,
} from 'aws-amplify/auth';
import type { Auth } from '../types';

export function createCognitoAuth(userPoolId: string, userPoolClientId: string): Auth {
  Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId } } });
  return {
    async currentUser() {
      try {
        await getCurrentUser();
        return (await fetchUserAttributes()).email ?? 'Signed in';
      } catch {
        return null;
      }
    },
    async requestCode(email) {
      // A stale half-finished sign-in would make signIn throw.
      await signOut().catch(() => undefined);
      const r = await signIn({
        username: email.trim(),
        options: { authFlowType: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
      });
      if (r.nextStep.signInStep !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') {
        throw new Error('Unexpected sign-in step: ' + r.nextStep.signInStep);
      }
    },
    async confirmCode(code) {
      const r = await confirmSignIn({ challengeResponse: code.trim() });
      if (!r.isSignedIn) throw new Error('That code was not accepted');
    },
    async signOut() {
      await signOut();
    },
  };
}
