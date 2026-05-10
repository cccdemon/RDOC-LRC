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

// Check if domain matches a pattern (supports wildcards like *.example.com)
function domainMatches(domain, pattern) {
  if (!domain || !pattern) return false;

  // Exact match
  if (domain === pattern) return true;

  // Wildcard match (*.example.com matches sub.example.com)
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2);
    return domain === baseDomain || domain.endsWith('.' + baseDomain);
  }

  return false;
}

// Extract all URLs from message content
function extractUrls(content) {
  if (!content) return [];

  const matches = content.match(URL_REGEX) || [];
  return matches.map(url => ({
    full: url,
    domain: extractDomain(url)
  })).filter(item => item.domain !== null);
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
      if (domainMatches(url.domain, pattern)) {
        isMatch = true;
        break;
      }
    }

    if (mode === 'allowlist' && !isMatch) {
      return {
        allowed: false,
        reason: `Domain "${url.domain}" is not in the allowlist`,
        blockedUrl: url.full
      };
    }
  }

  return { allowed: true };
}

module.exports = {
  extractUrls,
  extractDomain,
  domainMatches,
  checkWeblinkPolicy
};