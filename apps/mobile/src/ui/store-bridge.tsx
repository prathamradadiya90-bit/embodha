import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { startStoreListener, storeName } from '../lib/store';
import { notify } from './components';

/**
 * Picks up purchases that went through while the app wasn't looking: the phone lost signal mid-purchase, the app
 * was closed, or a payment that was pending has now cleared. Does nothing in the web build.
 */
export function StoreBridge() {
  const { signedIn } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!signedIn) return;
    return startStoreListener((result) => {
      void queryClient.invalidateQueries();
      if ('pending' in result) return;
      if (result.kind === 'course') notify('Your purchase went through', `${result.course.title} is in your library now.`);
      else notify('Your subscription is on', `Every course from ${result.instructor.displayName} is open to you, billed by ${storeName}.`);
    });
  }, [signedIn, queryClient]);

  return null;
}
