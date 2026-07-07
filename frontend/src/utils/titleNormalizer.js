// AMC frequently lists a "special event" showing of a movie it's already
// showing normally under a completely different title string (different
// capitalization, different wording, even a different AMC URL slug), e.g.
// "Moana" vs "MOANA IMAX Opening Night Fan Event". These patterns strip the
// known event-descriptor phrasing off the end of a title so the remaining
// "base" can be used as a display title, with the descriptor surfaced as a
// per-showing "variant" instead — the movie itself always merges into one
// list item; the variant becomes a sub-filter under it (see `buildTitleGroups`
// below and dataProcessor.js's `movieVariants`).
//
// `tag` (when present) becomes that variant, and is also injected into the
// showtime's format list as an informational badge.
//
// The separator between the movie name and the descriptor varies (AMC uses
// plain hyphens, en dashes, em dashes, and colons interchangeably), so every
// pattern is built with this shared, punctuation-agnostic prefix.
const SEP = '[\\s\\-\\u2013\\u2014:]*';

// `informational: true` marks patterns whose captured text is meaningful per-movie
// free text that's purely informational — e.g. "20th Anniversary Double Feature" or
// "Studio Ghibli Fest 2026" describe *why* this showing exists, not a distinct *kind*
// of showing worth its own filter checkbox. Callers (see `buildTitleGroups`) surface
// these as plain text under the movie instead of a sub-filter checkbox.
const DESCRIPTOR_PATTERNS = [
    { regex: new RegExp(`${SEP}(imax${SEP}opening\\s+night\\s+fan\\s+event)$`, 'i'), captureTag: true },
    { regex: new RegExp(`${SEP}(imax${SEP}70\\s*mm${SEP}event)$`, 'i'), captureTag: true },
    // Private Theatre Rental / Sensory Friendly Screening deliberately get no `tag`: AMC
    // already flags these showtimes with a genuine format of their own ("Private Theatre
    // Rentals", "Sensory Friendly Film"), which dataProcessor.js surfaces as an "Other
    // Filters" checkbox — so these just strip from the title for merging, with no separate
    // per-movie sub-filter checkbox and no duplicate injected tag.
    { regex: new RegExp(`${SEP}private\\s+theatre\\s+rental$`, 'i'), tag: null },
    { regex: new RegExp(`${SEP}sensory\\s+friendly\\s+screening$`, 'i'), tag: null },
    // `captureTag: true` means the matched capture group's text becomes the subtitle
    // verbatim (whitespace-trimmed, casing untouched) — for descriptors like these where
    // the trailing text varies per-title (a name list, a year) and can't be a fixed `tag`
    // string. Same idea as `informational` below, generalized to any variable text.
    { regex: new RegExp(`${SEP}(q&a\\s+with\\s+.+)$`, 'i'), captureTag: true },
    { regex: new RegExp(`${SEP}(studio\\s+ghibli\\s+fest(?:\\s+\\d+)?)$`, 'i'), informational: true },
    // Optionally allow "Celebrates (Its) Nth Anniversary" phrasing (e.g. "Mob Psycho 100
    // Celebrates Its 10th Anniversary") without pulling "Celebrates Its" into the base title.
    { regex: new RegExp(`${SEP}(?:celebrates\\s+(?:its\\s+)?)?(\\d+(?:st|nd|rd|th)\\s+anniversary(?:${SEP}double\\s+feature)?)$`, 'i'), informational: true },
];

// The set of concrete badge strings the descriptor patterns above can inject
// (excludes the anniversary label, which is per-movie free text, not a
// shared filter value). Single source of truth for dataProcessor.js so it
// doesn't need to re-hardcode this list to build the "Special Events" filter.
export const EVENT_BADGE_TAGS = new Set(
    DESCRIPTOR_PATTERNS.filter(p => p.tag).map(p => p.tag)
);

function titleCaseCaptured(text) {
    return text
        .trim()
        .replace(/\s+/g, ' ')
        .split(' ')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

// Strips known AMC event-descriptor phrasing off the end of a title, possibly
// more than one in sequence. Returns the cleaned base title plus the set of
// human-readable tags that were removed, and the specific informational label
// if one was matched (e.g. "20th Anniversary Double Feature", or null).
export function stripEventDescriptor(title) {
    let base = title.trim();
    const tags = [];
    let infoLabel = null;

    let matched = true;
    while (matched) {
        matched = false;
        for (const { regex, tag, informational, captureTag } of DESCRIPTOR_PATTERNS) {
            const match = base.match(regex);
            if (match) {
                base = base.replace(regex, '').trim();
                if (informational) {
                    infoLabel = titleCaseCaptured(match[1]);
                } else if (captureTag) {
                    const captured = match[1].trim().replace(/\s+/g, ' ');
                    if (captured && !tags.includes(captured)) tags.push(captured);
                } else if (tag && !tags.includes(tag)) {
                    tags.push(tag);
                }
                matched = true;
                break;
            }
        }
    }

    return { base, tags, infoLabel };
}

function smartTitleCase(str) {
    // Only re-case strings that look ALL-CAPS-shouty; leave normal mixed-case titles alone.
    if (str !== str.toUpperCase() || str === str.toLowerCase()) return str;
    const lowercaseWords = new Set(['a', 'an', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'vs', 'vs.']);
    return str
        .toLowerCase()
        .split(' ')
        .map((word, idx) => {
            if (idx > 0 && lowercaseWords.has(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

// Primary check: if a title is, case-insensitively, another known title plus
// more text after a separator (e.g. "Some Movie" -> "Some Movie: 4DX Sneak
// Peek"), the "more text" is almost certainly an AMC event qualifier — strip
// it and surface it as a subtitle, whether or not it also happens to match one
// of the curated DESCRIPTOR_PATTERNS below. Requires a full word-boundary
// match against the *other* title's whole text (not a partial-word prefix
// like "Moana" inside "Moanaland") so it only fires on genuine "title + extra"
// cases. Candidates are restricted to titles the curated patterns don't
// recognize (i.e. nothing to strip on their own), so this can't chain off an
// already-suffixed title.
function findPrefixMatch(title, candidates) {
    const titleNorm = title.trim().toLowerCase();
    let best = null;

    candidates.forEach(candidate => {
        if (candidate === title) return;
        const candidateTrimmed = candidate.trim();
        const candidateNorm = candidateTrimmed.toLowerCase();
        if (titleNorm.length <= candidateNorm.length || !titleNorm.startsWith(candidateNorm)) return;
        if (!/^[\s\-–—:]/.test(titleNorm.slice(candidateNorm.length))) return;

        if (!best || candidateNorm.length > best.norm.length) {
            best = { base: candidateTrimmed, norm: candidateNorm };
        }
    });

    if (!best) return null;

    const remainder = title.trim()
        .slice(best.norm.length)
        .replace(/^[\s\-–—:]+/, '')
        .trim();
    if (!remainder) return null;

    return { base: best.base, subtitle: remainder };
}

// Given every distinct raw movie title seen in the schedule, decides how each
// should be grouped and displayed. Returns a Map from each raw title to
// { movieKey, displayTitle, variant, isInformational }:
//   - `movieKey` is the identity used for selection/grouping — every title that's
//     a plain listing or a recognized event/anniversary variant of the same movie
//     shares one `movieKey`, so they all appear as ONE item in the UI.
//   - `displayTitle` is the text to render for that item.
//   - `variant` is the specific showing type for THIS raw title, if any (e.g.
//     "Fan Event Screening", "85th Anniversary"), or null for the plain listing.
//     Callers use this to offer per-movie sub-filters ("show only the Fan Event
//     showing") without needing a separate top-level list entry per variant.
//   - `isInformational` marks a `variant` that's just descriptive text (a
//     re-release anniversary, a festival name/year) rather than a distinct
//     "kind of showing" worth a filter checkbox for.
// Variant text that should never become a per-movie sub-filter checkbox, even if the
// generic title-prefix check (which doesn't know what the trailing text means) is what
// found it — AMC already flags these showtimes with a genuine format of their own
// ("Private Theatre Rentals", "Sensory Friendly Film"), surfaced under "Other Filters"
// instead. The title still strips normally for merging; only the variant is suppressed.
const SUPPRESSED_VARIANTS = [/^private\s+theatre\s+rental$/i, /^sensory\s+friendly\s+screening$/i];
const isSuppressedVariant = (text) => SUPPRESSED_VARIANTS.some(r => r.test(text));

export function buildTitleGroups(rawTitles) {
    const groups = new Map(); // key -> { members: [{ title, base, variant, isInformational }], cleanTitle }

    // Candidate pool for the title-prefix check: titles the curated descriptor
    // patterns don't recognize on their own, so a match can't chain off an
    // already-suffixed title.
    const cleanCandidates = [];
    rawTitles.forEach(title => {
        const { base } = stripEventDescriptor(title);
        if (base === title) cleanCandidates.push(title);
    });

    rawTitles.forEach(title => {
        let base;
        let variant = null;
        let isInformational = false;

        // First check: is this title just another known title with extra text tacked on?
        const prefixMatch = findPrefixMatch(title, cleanCandidates);
        if (prefixMatch) {
            base = prefixMatch.base;
            variant = prefixMatch.subtitle;
        } else {
            // Fallback: known AMC event-descriptor phrasing (curated patterns).
            const stripped = stripEventDescriptor(title);
            if (stripped.base) {
                base = stripped.base;
                if (stripped.infoLabel) {
                    variant = stripped.infoLabel;
                    isInformational = true;
                } else if (stripped.tags.length > 0) {
                    variant = stripped.tags[0];
                }
            } else {
                // Guard against a title that IS entirely the descriptor phrase (e.g. a bare
                // "Private Theatre Rental" listing with no movie name before it) — stripping
                // it down to an empty base would produce a blank display title, so treat it
                // as if nothing had matched and keep the original title intact.
                base = title;
            }
        }

        if (variant && !isInformational && isSuppressedVariant(variant)) variant = null;

        const key = (base.toLowerCase().replace(/\s+/g, ' ').trim()) || title.toLowerCase();
        if (!groups.has(key)) groups.set(key, { members: [] });
        const group = groups.get(key);
        group.members.push({ title, base, variant, isInformational });
        if (base === title) group.cleanTitle = title;
    });

    const result = new Map();

    groups.forEach(group => {
        // Prefer the un-suffixed listing's exact title as the display name;
        // otherwise smart-case the shortest variant's stripped base (e.g. avoid "MOANA").
        let displayTitle = group.cleanTitle;
        if (!displayTitle) {
            const shortest = group.members.reduce((a, b) => (b.base.length < a.base.length ? b : a));
            displayTitle = smartTitleCase(shortest.base);
        }

        group.members.forEach(({ title, variant, isInformational }) => {
            result.set(title, { movieKey: displayTitle, displayTitle, variant, isInformational });
        });
    });

    return result;
}
