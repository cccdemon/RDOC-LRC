'use strict';

const { log, logErr } = require('./log');

// URL regex to find URLs in message content
const URL_REGEX = /https?:\/\/[^\s]+/gi;

// Extract domain from URL
function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

// Split a weblink allowlist pattern into host and optional path portions.
function splitPattern(pattern) {
  const slashIndex = pattern.indexOf('/');
  if (slashIndex === -1) {
    return { hostPattern: pattern, pathPattern: '' };
  }
  return {
    hostPattern: pattern.slice(0, slashIndex),
    pathPattern: pattern.slice(slashIndex)
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostMatches(domain, hostPattern) {
  if (!domain || !hostPattern) return false;

  if (domain === hostPattern) return true;
  if (hostPattern.startsWith('*.')) {
    const baseDomain = hostPattern.slice(2);
    return domain === baseDomain || domain.endsWith('.' + baseDomain);
  }

  return false;
}

function pathMatches(pathname, pathPattern) {
  if (!pathPattern) return true;
  const pattern = pathPattern.startsWith('/') ? pathPattern : '/' + pathPattern;
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
  return regex.test(pathname || '/');
}

function patternMatches(url, pattern) {
  if (!url || !pattern) return false;
  const normalized = String(pattern).toLowerCase().trim();
  if (!normalized) return false;

  const { hostPattern, pathPattern } = splitPattern(normalized);
  if (!hostMatches(url.domain, hostPattern)) return false;
  return pathMatches(url.pathname, pathPattern);
}

// Extract all URLs from message content
function extractUrls(content) {
  if (!content) return [];

  const matches = content.match(URL_REGEX) || [];
  return matches.map(url => {
    try {
      const parsed = new URL(url);
      return {
        full: url,
        domain: parsed.hostname.toLowerCase(),
        pathname: parsed.pathname || '/'
      };
    } catch (e) {
      return { full: url, domain: null, pathname: '/' };
    }
  }).filter(item => item.domain !== null);
}

// Check if any URL in the message violates the weblink policy
function checkWeblinkPolicy(urls, mode, list) {
  if (!urls || urls.length === 0) return { allowed: true };

  if (mode === 'none' || !list || list.length === 0) {
    return { allowed: true };
  }

  for (const url of urls) {
    let isMatch = false;
    for (const pattern of list) {
      if (patternMatches(url, pattern)) {
        isMatch = true;
        break;
      }
    }

    if (mode === 'allowlist' && !isMatch) {
      return {
        allowed: false,
        reason: `URL "${url.full}" is not in the allowlist`,
        blockedUrl: url.full
      };
    }
  }

  return { allowed: true };
}

module.exports = {
  extractUrls,
  extractDomain,
  patternMatches,
  checkWeblinkPolicy
};