/**
 * ISO 3166-1 alpha-2 → country name and calling code.
 *
 * Tuya routes an account to a regional data centre by country calling code, and
 * rejects a sign-in aimed at the wrong one as an access error rather than a
 * credentials error — so the code is needed even for an email account, and asking a
 * rider to type one reads like a request for a phone number. This table exists so the
 * region can be detected from the device instead, and picked by country name when the
 * detection is wrong.
 *
 * Stored as a packed string rather than an object literal purely for size; it is parsed
 * once on first use.
 */
const TABLE =
  'AD:Andorra:376|AE:United Arab Emirates:971|AF:Afghanistan:93|AL:Albania:355|AM:Armenia:374|' +
  'AO:Angola:244|AR:Argentina:54|AT:Austria:43|AU:Australia:61|AZ:Azerbaijan:994|' +
  'BA:Bosnia and Herzegovina:387|BB:Barbados:1|BD:Bangladesh:880|BE:Belgium:32|BF:Burkina Faso:226|' +
  'BG:Bulgaria:359|BH:Bahrain:973|BI:Burundi:257|BJ:Benin:229|BN:Brunei:673|' +
  'BO:Bolivia:591|BR:Brazil:55|BS:Bahamas:1|BT:Bhutan:975|BW:Botswana:267|' +
  'BY:Belarus:375|BZ:Belize:501|CA:Canada:1|CD:DR Congo:243|CF:Central African Republic:236|' +
  'CG:Congo:242|CH:Switzerland:41|CI:Ivory Coast:225|CL:Chile:56|CM:Cameroon:237|' +
  'CN:China:86|CO:Colombia:57|CR:Costa Rica:506|CU:Cuba:53|CV:Cape Verde:238|' +
  'CY:Cyprus:357|CZ:Czechia:420|DE:Germany:49|DJ:Djibouti:253|DK:Denmark:45|' +
  'DO:Dominican Republic:1|DZ:Algeria:213|EC:Ecuador:593|EE:Estonia:372|EG:Egypt:20|' +
  'ER:Eritrea:291|ES:Spain:34|ET:Ethiopia:251|FI:Finland:358|FJ:Fiji:679|' +
  'FR:France:33|GA:Gabon:241|GB:United Kingdom:44|GE:Georgia:995|GH:Ghana:233|' +
  'GM:Gambia:220|GN:Guinea:224|GQ:Equatorial Guinea:240|GR:Greece:30|GT:Guatemala:502|' +
  'GY:Guyana:592|HK:Hong Kong:852|HN:Honduras:504|HR:Croatia:385|HT:Haiti:509|' +
  'HU:Hungary:36|ID:Indonesia:62|IE:Ireland:353|IL:Israel:972|IN:India:91|' +
  'IQ:Iraq:964|IR:Iran:98|IS:Iceland:354|IT:Italy:39|JM:Jamaica:1|' +
  'JO:Jordan:962|JP:Japan:81|KE:Kenya:254|KG:Kyrgyzstan:996|KH:Cambodia:855|' +
  'KR:South Korea:82|KW:Kuwait:965|KZ:Kazakhstan:7|LA:Laos:856|LB:Lebanon:961|' +
  'LK:Sri Lanka:94|LR:Liberia:231|LS:Lesotho:266|LT:Lithuania:370|LU:Luxembourg:352|' +
  'LV:Latvia:371|LY:Libya:218|MA:Morocco:212|MC:Monaco:377|MD:Moldova:373|' +
  'ME:Montenegro:382|MG:Madagascar:261|MK:North Macedonia:389|ML:Mali:223|MM:Myanmar:95|' +
  'MN:Mongolia:976|MO:Macau:853|MT:Malta:356|MU:Mauritius:230|MV:Maldives:960|' +
  'MW:Malawi:265|MX:Mexico:52|MY:Malaysia:60|MZ:Mozambique:258|NA:Namibia:264|' +
  'NE:Niger:227|NG:Nigeria:234|NI:Nicaragua:505|NL:Netherlands:31|NO:Norway:47|' +
  'NP:Nepal:977|NZ:New Zealand:64|OM:Oman:968|PA:Panama:507|PE:Peru:51|' +
  'PG:Papua New Guinea:675|PH:Philippines:63|PK:Pakistan:92|PL:Poland:48|PR:Puerto Rico:1|' +
  'PT:Portugal:351|PY:Paraguay:595|QA:Qatar:974|RO:Romania:40|RS:Serbia:381|' +
  'RU:Russia:7|RW:Rwanda:250|SA:Saudi Arabia:966|SD:Sudan:249|SE:Sweden:46|' +
  'SG:Singapore:65|SI:Slovenia:386|SK:Slovakia:421|SN:Senegal:221|SO:Somalia:252|' +
  'SR:Suriname:597|SV:El Salvador:503|SY:Syria:963|SZ:Eswatini:268|TD:Chad:235|' +
  'TG:Togo:228|TH:Thailand:66|TJ:Tajikistan:992|TM:Turkmenistan:993|TN:Tunisia:216|' +
  'TR:Turkey:90|TT:Trinidad and Tobago:1|TW:Taiwan:886|TZ:Tanzania:255|UA:Ukraine:380|' +
  'UG:Uganda:256|US:United States:1|UY:Uruguay:598|UZ:Uzbekistan:998|VE:Venezuela:58|' +
  'VN:Vietnam:84|YE:Yemen:967|ZA:South Africa:27|ZM:Zambia:260|ZW:Zimbabwe:263';

export type Country = { region: string; name: string; callingCode: string };

let parsed: Country[] | null = null;

export function countries(): Country[] {
  if (!parsed) {
    parsed = TABLE.split('|').map((entry) => {
      const [region, name, callingCode] = entry.split(':');
      return { region, name, callingCode };
    });
  }
  return parsed;
}

// Each of the two letters maps to a Unicode "regional indicator symbol" — flags are
// not stored as emoji or images, they're just those two code points rendered
// side-by-side, which every Android font already knows how to draw as a flag.
const REGIONAL_INDICATOR_OFFSET = 0x1f1e6 - 0x41;

export function countryFlag(region: string): string {
  return region
    .toUpperCase()
    .split('')
    .map((letter) => String.fromCodePoint(letter.charCodeAt(0) + REGIONAL_INDICATOR_OFFSET))
    .join('');
}

/** Fallback when the device reports a region we don't know — Tuya's own default. */
const FALLBACK: Country = { region: 'US', name: 'United States', callingCode: '1' };

// expo-localization autolinks a native module that a dev client built before the
// dependency was added doesn't have — the require must stay lazy (inside the call)
// so importing this file can't crash at module scope.
function deviceRegionCode(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLocales } = require('expo-localization');
    return getLocales()[0]?.regionCode ?? null;
  } catch {
    return null;
  }
}

/**
 * The SIM/cellular network's country, which is what Tuya's data-centre routing
 * actually needs — unlike the OS locale region, it does not depend on what
 * language the rider has their phone set to. A device with English (United
 * States) as its display language but a Swedish SIM on a Swedish network reports
 * region "US" from expo-localization and "SE" from here; this is the one that is
 * actually right. Same lazy-require guard as deviceRegionCode: a dev client built
 * before this native function existed must not crash importing this file.
 */
function networkCountryCode(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const DevicePower = require('@modules/device-power/src/DevicePower').default;
    return DevicePower.networkCountryIso();
  } catch {
    return null;
  }
}

/**
 * The device's own region, which is right for essentially every real user and spares
 * them being asked for something that looks like a phone number. Network/SIM country
 * is tried first — it reflects where the phone actually is, where the OS locale only
 * reflects a language preference — falling back to the locale region for a Wi-Fi-only
 * device with no SIM, then to Tuya's own US default.
 */
export function detectCountry(): Country {
  try {
    const region = networkCountryCode() ?? deviceRegionCode();
    if (!region) return FALLBACK;
    return countries().find((c) => c.region === region.toUpperCase()) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
