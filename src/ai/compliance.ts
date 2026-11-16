import type {BrandOfferDto, BrandProductDto} from '../brand/brand.dto';

export type ComplianceBrand = {
  products: BrandProductDto[];
  approvedOffers: BrandOfferDto[];
  doNotSay: string[];
};

export type ComplianceFlag = {code: string; message: string; excerpt: string};

// Bengali digits are normalised to ASCII before matching.
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const normaliseDigits = (s: string) => s.replace(/[০-৯]/g, d => String(BN_DIGITS.indexOf(d)));

const PRICE = /(?:৳|tk\.?|taka|টাকা|bdt|usd|\$|rs\.?)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:৳|tk\b|taka|টাকা|bdt|\/-)/gi;
const PERCENT_OFF = /\d{1,3}\s?%\s?(?:off|discount|ছাড়|cashback)/gi;
const PROMO = /\b(?:buy\s+(?:one|1)\s+get\s+(?:one|1)|bogo|free\s+(?:delivery|shipping|gift)|flash\s+sale|limited[-\s]time\s+offer|discount|promo\s?code|coupon)\b|ছাড়|অফার/gi;
const TESTIMONIAL =
  /(?:customers?\s+(?:say|said|love|rave)|“[^”]{12,}”\s*[-—–]\s*\S+|"[^"]{12,}"\s*[-—–]\s*\S+|rated\s+\d(?:\.\d)?\s?(?:stars?|\/\s?5)|\d[\d,]*\s?k?\+?\s+(?:happy|satisfied|loyal)\s+customers)/gi;

const numbersIn = (s: string) => (normaliseDigits(s).match(/\d+(?:\.\d+)?/g) || []).map(n => n.replace(/^0+(?=\d)/, ''));

/**
 * Deterministic server-side check that generated or edited copy only states facts from the
 * brand kit (PRD FR-02, section 12, TEST-13). It flags; humans decide.
 */
export function checkCompliance(text: string, brand: ComplianceBrand): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  const source = normaliseDigits(text);
  const approvedText = normaliseDigits(
    [
      ...brand.products.map(p => `${p.name} ${p.price || ''} ${p.description || ''}`),
      ...brand.approvedOffers.map(o => `${o.title} ${o.details || ''}`),
    ].join(' '),
  );
  const approvedNumbers = new Set(numbersIn(approvedText.replace(/,/g, '')));

  for (const match of source.matchAll(PRICE)) {
    const amounts = numbersIn(match[0].replace(/,/g, ''));
    if (amounts.length === 0 || amounts.some(n => !approvedNumbers.has(n))) {
      flags.push({
        code: 'unverified_price',
        message: 'Mentions a price that is not in the brand kit.',
        excerpt: match[0].trim(),
      });
    }
  }

  for (const match of source.matchAll(PERCENT_OFF)) {
    const [pct] = numbersIn(match[0]);
    if (!approvedNumbers.has(pct)) {
      flags.push({
        code: 'unverified_offer',
        message: 'Mentions a discount that is not an approved offer.',
        excerpt: match[0].trim(),
      });
    }
  }

  if (brand.approvedOffers.length === 0) {
    for (const match of source.matchAll(PROMO)) {
      flags.push({
        code: 'unverified_offer',
        message: 'Mentions a promotion, but the brand kit has no approved offers.',
        excerpt: match[0].trim(),
      });
    }
  }

  for (const match of source.matchAll(TESTIMONIAL)) {
    flags.push({
      code: 'possible_testimonial',
      message: 'Looks like a testimonial or rating; make sure it is real and you may use it.',
      excerpt: match[0].trim().slice(0, 80),
    });
  }

  const lower = text.toLowerCase();
  for (const term of brand.doNotSay) {
    if (term && lower.includes(term.toLowerCase())) {
      flags.push({code: 'restricted_term', message: `Uses a do-not-say term: "${term}".`, excerpt: term});
    }
  }

  const seen = new Set<string>();
  return flags.filter(f => {
    const key = `${f.code}:${f.excerpt.toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

export const flagKey = (f: ComplianceFlag) => `${f.code}:${f.excerpt}`;
