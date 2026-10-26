const { simplifyTorrentName } = require('../utils/torrent');

describe('simplifyTorrentName', () => {
  it('should return "Sans nom" if name is falsy', () => {
    expect(simplifyTorrentName(null)).toBe('Sans nom');
    expect(simplifyTorrentName(undefined)).toBe('Sans nom');
    expect(simplifyTorrentName('')).toBe('Sans nom');
  });

  it('should replace dots and underscores with spaces', () => {
    expect(simplifyTorrentName('Mon.Film.Super.2023_Release')).toBe('Mon Film Super 2023 Release');
  });

  it('should remove tags in brackets', () => {
    expect(simplifyTorrentName('[Team-Release] Mon Super Film')).toBe('Mon Super Film');
    expect(simplifyTorrentName('Mon Super Film [1080p]')).toBe('Mon Super Film');
    expect(simplifyTorrentName('[Tag1] [Tag2] Film')).toBe('Film');
  });

  it('should remove resolutions, codecs, and sources with or without parentheses', () => {
    expect(simplifyTorrentName('Un Film Génial (1080p x264)')).toBe('Un Film Génial');
    expect(simplifyTorrentName('Un Film Génial (2160p HEVC BluRay)')).toBe('Un Film Génial');
    expect(simplifyTorrentName('Un Film Génial (720p WEB-DL)')).toBe('Un Film Génial');

    expect(simplifyTorrentName('Un Autre Film 2160p HEVC')).toBe('Un Autre Film');
    expect(simplifyTorrentName('Le.Film.2021.BluRay.1080p')).toBe('Le Film 2021');
    expect(simplifyTorrentName('Film 720p x265 WEB-DL')).toBe('Film');
    expect(simplifyTorrentName('Film HDRip BDRip DVDRip')).toBe('Film');
  });

  it('should remove languages and release tags', () => {
    expect(simplifyTorrentName('Film.MULTI.FRENCH.VOSTFR.1080p')).toBe('Film');
    expect(simplifyTorrentName('Film.TRUEFRENCH.720p')).toBe('Film');
    expect(simplifyTorrentName('Film VFF VFI')).toBe('Film');
  });

  it('should remove correction tags like PROPER and REPACK', () => {
    expect(simplifyTorrentName('Mon.Film.PROPER.REPACK.1080p')).toBe('Mon Film');
  });

  it('should trim and remove multiple spaces', () => {
    expect(simplifyTorrentName('   Film   Avec    Espaces   ')).toBe('Film Avec Espaces');
  });

  it('should handle a combination of multiple tags and formatting', () => {
    const complexName = '[ReleaseGroup] Super.Movie.2024.TRUEFRENCH.2160p.HEVC.WEB-DL.PROPER-Team (x265 VFF)';
    expect(simplifyTorrentName(complexName)).toBe('Super Movie 2024 -Team');
  });

  it('should return the original name if cleaning results in an empty string (edge case)', () => {
    expect(simplifyTorrentName('1080p')).toBe('1080p');
  });
});
