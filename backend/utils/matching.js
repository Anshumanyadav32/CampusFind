const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "with",
  "of", "by", "from", "my", "is", "it", "lost", "found", "item", "please", "help"
]);

export function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

export function diceCoefficient(str1, str2) {
  const s1 = normalize(str1);
  const s2 = normalize(str2);
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const getBigrams = (str) => {
    const bigrams = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.slice(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);
  let intersection = 0;

  for (const [bigram, count1] of bg1.entries()) {
    if (bg2.has(bigram)) {
      intersection += Math.min(count1, bg2.get(bigram));
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}

export function calculateNameSimilarity(nameA, nameB) {
  const normA = normalize(nameA);
  const normB = normalize(nameB);

  if (!normA || !normB) return 0;
  if (normA === normB) return 40;

  // Substring inclusion (e.g. "iPhone 13" inside "iPhone 13 Pro (Blue)")
  if (normA.includes(normB) || normB.includes(normA)) {
    return 35;
  }

  // Tokenized keyword overlap
  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);

  if (tokensA.length > 0 && tokensB.length > 0) {
    const commonTokens = tokensA.filter((token) => tokensB.includes(token));
    if (commonTokens.length > 0) {
      const minLen = Math.min(tokensA.length, tokensB.length);
      const overlapRatio = commonTokens.length / minLen;
      if (overlapRatio >= 0.75) return 35;
      if (overlapRatio >= 0.5) return 28;
      return 20;
    }
  }

  // Fallback to character bigram similarity
  const dice = diceCoefficient(normA, normB);
  if (dice >= 0.7) return 30;
  if (dice >= 0.5) return 20;

  return 0;
}

export function calculateCategorySimilarity(catA, catB) {
  const normA = normalize(catA);
  const normB = normalize(catB);

  if (!normA || !normB) return 5;
  if (normA === normB) return 25;

  // Flexible check (e.g., "Electronics" vs "Electronic", "Bags" vs "Bag")
  if (normA.startsWith(normB) || normB.startsWith(normA)) {
    return 20;
  }

  return 0;
}

export function calculateColorSimilarity(colA, colB) {
  const normA = normalize(colA);
  const normB = normalize(colB);

  // Missing or generic color is neutral (doesn't overly penalize)
  const neutralColors = new Set(["", "other", "unknown", "n/a", "any"]);
  if (neutralColors.has(normA) || neutralColors.has(normB)) {
    return 8;
  }

  if (normA === normB) return 20;

  // Flexible / compound color match (e.g., "Navy Blue" vs "Blue", "Dark Gray" vs "Grey")
  if (normA.includes(normB) || normB.includes(normA)) {
    return 15;
  }

  // Common synonyms
  const synonyms = [
    ["gray", "grey", "silver"],
    ["black", "dark", "charcoal"],
    ["blue", "navy", "cyan", "indigo"],
    ["red", "maroon", "crimson", "burgundy"],
    ["brown", "tan", "beige", "khaki"]
  ];

  for (const group of synonyms) {
    if (group.some((w) => normA.includes(w)) && group.some((w) => normB.includes(w))) {
      return 14;
    }
  }

  return 0;
}

export function calculateLocationSimilarity(locA, locB) {
  const normA = normalize(locA);
  const normB = normalize(locB);

  if (!normA || !normB) return 5;
  if (normA === normB) return 15;

  if (normA.includes(normB) || normB.includes(normA)) {
    return 12;
  }

  const tokensA = tokenize(locA);
  const tokensB = tokenize(locB);
  const common = tokensA.filter((t) => tokensB.includes(t));

  if (common.length > 0) {
    return 10;
  }

  return 0;
}

export function calculateMatchScore(lost, found) {
  const nameScore = calculateNameSimilarity(lost.itemName, found.itemName);
  const categoryScore = calculateCategorySimilarity(lost.category, found.category);
  const colorScore = calculateColorSimilarity(lost.color, found.color);
  const locationScore = calculateLocationSimilarity(lost.location, found.location);

  const total = nameScore + categoryScore + colorScore + locationScore;
  return Math.min(100, Math.max(0, total));
}

export function isMatchConfident(score) {
  return score >= 55;
}

export function getConfidenceLevel(score) {
  if (score >= 80) return "high";
  if (score >= 65) return "medium";
  if (score >= 55) return "low";
  return "unlikely";
}

export function buildCandidateQuery(item, itemId) {
  const oppositeType = normalize(item.reportType) === "lost" ? "found" : "lost";
  const tokens = tokenize(item.itemName);
  const conditions = [];

  // Match category if present
  if (item.category) {
    conditions.push({ category: { $regex: escapeRegex(item.category), $options: "i" } });
  }

  // Or match any significant keyword in title (up to top 5)
  for (const token of tokens.slice(0, 5)) {
    conditions.push({ itemName: { $regex: escapeRegex(token), $options: "i" } });
  }

  const query = {
    reportType: oppositeType,
    status: { $nin: ["returned", "closed"] },
    moderationStatus: { $in: ["active", null] },
    _id: { $ne: itemId }
  };

  if (conditions.length > 0) {
    query.$or = conditions;
  }

  return query;
}
