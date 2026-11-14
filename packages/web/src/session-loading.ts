/** What decides whether a session tab with no view shows the loading skeleton (GH-774). */
export type LoadFacts = { view: boolean; listed: boolean; failed: boolean; listLoaded: boolean };

/** No view yet, the subscribe has not failed, and the session is listed (or the list is not there yet: a reload). */
export const showsSkeleton = (f: LoadFacts): boolean => !f.view && !f.failed && (f.listed || !f.listLoaded);
