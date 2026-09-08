// Shared by any source whose listings are agent-submitted free text with
// per-language slots (RE/MAX, Century 21, ...): some agents paste the same
// ad copy once per language into a single field rather than using the
// site's own translation slots properly, so the "pt" field itself can
// contain a PT paragraph followed by an EN/ES/FR/DE one. The PT-PT
// requirement is absolute, so anything from the first foreign-looking
// paragraph onward is dropped entirely rather than risking non-Portuguese
// text leaking onto the site.

// Word-boundary function words distinctive enough to tell Portuguese
// paragraphs apart from a foreign one appended after it. Deliberately not a
// real language detector — just enough signal for this specific pattern.
// "são" (case-insensitively) is excluded on purpose: capitalised "São" is
// the extremely common Portuguese place-name prefix ("São João", "São
// Domingos de Benfica", ...), not the verb — matching it case-insensitively
// gives a false PT signal that can let a real foreign paragraph through.
// Only the lowercase verb form is counted, via a separate check.
const PT_MARKERS =
  /\b(de|da|do|das|dos|para|com|uma|um|que|não|está|mais|em|os|as|se|ao|à|é|ou|também|muito|esta|este|onde|isto|seu|sua|foi|ser|tem|têm|pelo|pela|pelos|pelas|nas|nos|na|no|imóvel|localizado|localizada|quarto|quartos|casa|sala|cozinha|varanda|desta|deste|nesta|neste|ainda|todos|toda|cada|entre)\b/gi;
const PT_MARKER_LOWERCASE_SAO = /\bsão\b/;
const FOREIGN_MARKERS =
  /\b(the|and|with|this|for|are|from|your|you|will|our|have|has|located|view|views|bedroom|bedrooms|bathroom|bathrooms|kitchen|house|apartment|property|floor|living|room|of|is|to|it|welcomes?|offers?|features?|includes?|situated|access|space|design(ed)?|el|la|los|las|en|con|una|uno|habitaci[oó]n|habitaciones|baño|dormitorio|dormitorios|vivienda|le|les|des|und|der|die|das|zimmer|wohnung)\b/gi;

function countMatches(re, text) {
  return (text.match(re) || []).length;
}

function countPtMarkers(text) {
  return countMatches(PT_MARKERS, text) + countMatches(PT_MARKER_LOWERCASE_SAO, text);
}

// Surveyed across hundreds of real RE/MAX listings: seen as any length/mix
// of * - _ = ~ + # `, as three-or-more literal dots ("..."), and as a
// single "…" ellipsis character. A LONE "." is deliberately not treated as
// a divider — unlike the others it's plausible as a genuine (if awkwardly
// split) end of a Portuguese sentence, not just separator punctuation.
function isDividerLine(paragraph) {
  const trimmed = paragraph.trim();
  if (!trimmed) return false;
  return /^…+$/.test(trimmed) || /^\.{3,}$/.test(trimmed) || /^[*\-_=~+#`]+$/.test(trimmed);
}

export function cutAtLanguageSwitch(text) {
  const paragraphs = text.split(/\n{2,}/);
  const kept = [];
  for (const paragraph of paragraphs) {
    if (isDividerLine(paragraph)) break;
    const wordCount = (paragraph.match(/\S+/g) || []).length;
    const ptScore = countPtMarkers(paragraph);
    const foreignScore = countMatches(FOREIGN_MARKERS, paragraph);
    // A short heading-style paragraph (e.g. a translated title repeating
    // the ad above it) often has only one distinctly-foreign word — but a
    // genuinely Portuguese paragraph of 2+ words practically always
    // contains at least one of the extremely common PT function words, so
    // zero PT hits plus any foreign hit is still a safe signal.
    const isForeign =
      wordCount >= 2 && (ptScore === 0 ? foreignScore >= 1 : foreignScore >= 3 && foreignScore > ptScore * 1.5);
    if (isForeign) break;
    kept.push(paragraph);
  }
  return kept.join("\n\n").trim();
}
