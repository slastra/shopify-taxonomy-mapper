const GID_PREFIX = 'gid://shopify/TaxonomyCategory/';

export function stripGid(id: string): string {
  return id.startsWith(GID_PREFIX) ? id.slice(GID_PREFIX.length) : id;
}

export function toGid(shortId: string): string {
  return shortId.startsWith(GID_PREFIX) ? shortId : `${GID_PREFIX}${shortId}`;
}
