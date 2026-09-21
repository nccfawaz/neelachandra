/**
 * Convenience readers. They throw rather than return null, because they are
 * only called downstream of requireAuth, and a null there is a routing bug
 * that should be loud rather than a page rendering as a guest.
 */
export function currentUser(c) {
    const u = c.get('user');
    if (!u)
        throw new Error('currentUser called outside an authenticated route');
    return u;
}
export function currentSession(c) {
    const s = c.get('session');
    if (!s)
        throw new Error('currentSession called outside an authenticated route');
    return s;
}
export function currentScope(c) {
    const s = c.get('scope');
    if (!s)
        throw new Error('currentScope called outside an authenticated route');
    return s;
}
