function simplifyTorrentName(name) {
  if (!name) return "Sans nom";
  const cleaned = name
    .replace(/[._]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(
      /\([^)]*(1080p|2160p|720p|x264|x265|h\.?264|h\.?265|hevc|bluray|webrip|web-dl|dvdrip|hdrip|bdrip)[^)]*\)/gi,
      " ",
    )
    .replace(
      /\b(1080p|2160p|720p|x264|x265|h\.?264|h\.?265|hevc|bluray|webrip|web-dl|dvdrip|hdrip|bdrip|proper|repack|multi|french|truefrench|vostfr|vff|vfi)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name;
}

module.exports = { simplifyTorrentName };
