// The same physical property is often cross-posted by an agent to several
// portals at once — with 5 sources now, that means the same listing can
// legitimately show up on the site multiple times, once per source. There's
// no shared id across sources to key on, so this correlates listings by a
// conservative combination of independent signals instead: near-identical
// coordinates, an exact price match, and (when known on both sides)
// matching bedroom count and floor area. Any single one of those signals
// alone is too weak (many different nearby properties share a price point;
// geocoding precision varies enough between sources that "identical
// coordinates" isn't reliable on its own) — requiring all of them together
// keeps false merges (hiding two genuinely different listings as one) rare,
// at the cost of missing some real duplicates whose price or specs drifted
// out of sync between portals. That tradeoff is deliberate: showing the
// same property twice is a minor annoyance, but silently dropping a
// distinct listing because it was wrongly merged is a real loss.

const EARTH_RADIUS_M = 6371000;
const MAX_DISTANCE_M = 150;
const MAX_AREA_DIFF_M2 = 3;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function isLikelySameListing(a, b) {
  if (a.source.name === b.source.name) return false;
  if (a.type !== b.type || a.price !== b.price) return false;
  if (a.bedrooms != null && b.bedrooms != null && a.bedrooms !== b.bedrooms) return false;
  if (a.area_m2 != null && b.area_m2 != null && Math.abs(a.area_m2 - b.area_m2) > MAX_AREA_DIFF_M2) return false;
  return haversineMeters(a.geo.lat, a.geo.lng, b.geo.lat, b.geo.lng) <= MAX_DISTANCE_M;
}

// Prefers whichever listing gives the visitor the richer page — already
// enriched with full detail beats not, more photos beats fewer — falling
// back to a fixed, deterministic tiebreak (rather than e.g. "first seen")
// so the choice doesn't flip-flop between runs when everything else ties.
function preferKeeper(a, b) {
  const aFull = a.images && a.images.length > 1;
  const bFull = b.images && b.images.length > 1;
  if (aFull !== bFull) return aFull ? a : b;
  const aPhotos = a.images ? a.images.length : 0;
  const bPhotos = b.images ? b.images.length : 0;
  if (aPhotos !== bPhotos) return aPhotos > bPhotos ? a : b;
  return a.id < b.id ? a : b;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }
  find(id) {
    while (this.parent.get(id) !== id) {
      this.parent.set(id, this.parent.get(this.parent.get(id)));
      id = this.parent.get(id);
    }
    return id;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// Grouping candidates by "type|price" before comparing pairs avoids an
// O(n²) sweep over the whole catalogue — an exact price match is required
// anyway, so only listings that already agree on it are ever compared
// against each other, and those groups are small in practice.
export function removeDuplicateListings(listings) {
  const priceGroups = new Map();
  for (const listing of listings) {
    if (!listing.geo || listing.price == null) continue;
    const key = `${listing.type}|${listing.price}`;
    if (!priceGroups.has(key)) priceGroups.set(key, []);
    priceGroups.get(key).push(listing);
  }

  const uf = new UnionFind(listings.map((l) => l.id));
  for (const group of priceGroups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (isLikelySameListing(group[i], group[j])) uf.union(group[i].id, group[j].id);
      }
    }
  }

  const groupsByRoot = new Map();
  for (const listing of listings) {
    const root = uf.find(listing.id);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, []);
    groupsByRoot.get(root).push(listing);
  }

  const kept = [];
  let removedCount = 0;
  const examples = [];
  for (const group of groupsByRoot.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const keeper = group.reduce(preferKeeper);
    kept.push(keeper);
    removedCount += group.length - 1;
    if (examples.length < 10) {
      examples.push(
        `mantido ${keeper.source.name} (${keeper.id}) — removido(s) ${group
          .filter((l) => l !== keeper)
          .map((l) => `${l.source.name} (${l.id})`)
          .join(", ")}`
      );
    }
  }

  if (removedCount > 0) {
    console.log(`[dedupe] ${removedCount} anúncios duplicados entre fontes removidos (${examples.length} de exemplo):`);
    for (const example of examples) console.log(`  ${example}`);
  }

  return kept;
}
