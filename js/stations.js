// Airport -> country, and the "domestic" area of the Overseas Route Map (Appendix I).
//
// Domestic duty day (7.02 Note 2): every station inside the line drawn on the Overseas Route Map:
// Canada, the U.S. mainland and Alaska, Mexico, Central America down to Costa Rica, Cuba, Jamaica,
// the Bahamas, the Cayman Islands, Bermuda and St-Pierre. Outside the line (overseas): Hawaii,
// Hispaniola (Dominican Republic, Haiti), Puerto Rico, Turks & Caicos, the Lesser Antilles,
// Panama, South America, Europe, Africa, Asia and the Pacific.

// Canadian IATA codes almost all start with "Y". These "Y" codes are in the U.S.
const US_Y_CODES = new Set(['YUM', 'YKM', 'YAK', 'YNG', 'YIP']);

// Canadian codes that do not start with "Y".
const CA_OTHER = new Set(['ZBF', 'ZSJ', 'ZEL', 'ZFM', 'ZJN', 'ZKE', 'ZNA', 'ZQS', 'ZSW', 'ZST', 'ZUM', 'ZWL', 'ZAC', 'ZGI', 'ZGR', 'ZLT', 'ZPB', 'ZRJ', 'ZTM', 'XBE', 'XKS', 'XGR', 'XLB', 'XPK', 'XSI', 'XTL', 'KEW', 'KIF', 'MSA', 'SUR', 'WNN', 'ILF', 'GSL', 'LAK', 'TNS', 'CJH']);

// U.S. commercial airports (50 states).
const US_CODES = new Set(`
ABE ABI ABQ ABR ABY ACK ACT ACV ACY ADK ADQ AEX AGS AKN ALB ALO ALW AMA ANC APN ASE ATL ATW ATY AUS AVL AVP AZA AZO
BDL BET BFF BFL BGM BGR BHM BIH BIL BIS BJI BKG BLI BLV BMI BNA BOI BOS BPT BQK BRD BRL BRO BRW BTM BTR BTV BUF BUR BWI BZN
CAE CAK CDB CDC CDV CEC CGI CHA CHO CHS CIC CID CIU CKB CLE CLL CLT CMH CMI CMX CNY COD COS COU CPR CRP CRW CSG CVG CWA CYS
DAB DAL DAY DBQ DCA DDC DEC DEN DFW DHN DIK DLG DLH DRO DRT DSM DTW DUJ DVL EAR EAU ECP EGE EKO ELM ELP ERI ESC EUG EVV EWN EWR EYW
FAI FAR FAT FAY FCA FLG FLL FLO FMN FNT FOD FOE FSD FSM FWA GCC GCK GCN GEG GFK GGG GGW GJT GNV GPT GRB GRI GRK GRR GSO GSP GTF GTR GUC
HDN HGR HHH HIB HLN HNL HOB HOU HPN HRL HSV HTS HVN HYA HYS IAD IAG IAH ICT IDA ILG ILM IMT IND INL IPT ISN ISP ITH ITO
JAC JAN JAX JFK JHM JLN JMS JNU JST KOA KTN LAN LAR LAS LAW LAX LBB LBE LBF LBL LCH LCK LEB LEX LFT LGA LGB LIH LIT LMT LNK LNY LRD LSE LWB LWS LYH
MAF MBS MCE MCI MCK MCN MCO MCW MDT MDW MEI MEM MFE MFR MGM MGW MHK MHT MIA MKE MKG MKK MLB MLI MLU MMH MOB MOT MQT MRY MSL MSN MSO MSP MSS MSY MTJ MVY MWA MYR
OAJ OAK OGD OGG OGS OKC OMA OME ONT ORD ORF ORH OTH OTZ OWB OXR PAE PAH PBG PBI PDT PDX PGA PGD PGV PHF PHL PHX PIA PIB PIE PIH PIR PIT PKB PLN PNS PQI PRC PSC PSG PSM PSP PUB PUW PVC PVD PVU PWM
RAP RDD RDM RDU RFD RHI RIC RIW RKS RNO ROA ROC ROW RST RSW SAF SAN SAT SAV SBA SBN SBP SBY SCC SCE SCK SDF SEA SFB SFO SGF SGU SHD SHR SHV SIT SJC SJT SLC SLK SLN SMF SMX SNA SPI SPS SRQ STC STL STS SUN SUX SWF SWO SYR
TBN TEX TLH TOL TPA TRI TTN TUL TUP TUS TVC TWF TXK TYR TYS UIN UNK VCT VDZ VEL VLD VPS WRG WYS XNA YKM YUM`.trim().split(/\s+/));

// Hawaii is outside the line on the Overseas Route Map.
const HAWAII = new Set(['HNL', 'OGG', 'LIH', 'KOA', 'ITO', 'MKK', 'LNY']);

// Air Canada / Rouge / Jazz stations outside Canada and the U.S. (ISO country codes).
const OTHER = `
MX: CUN PVR SJD MEX GDL ZIH HUX CZM MZT ZLO NLU OAX MID MTY TQO ACA LTO CJS TIJ BJX QRO SLP VER
GT: GUA FRS   BZ: BZE   SV: SAL   HN: RTB SAP TGU XPL   NI: MGA   CR: SJO LIR   PA: PTY
CU: HAV VRA SNU CCC HOG SCU CYO MZO CFG   JM: KIN MBJ OCJ   BS: NAS GGT ELH FPO MHH   KY: GCM   BM: BDA   PM: FSP
TC: PLS   DO: PUJ POP SDQ LRM STI AZS   HT: PAP   PR: SJU BQN   VI: STT STX   VG: EIS   SX: SXM   MF: SFG
AG: ANU   BB: BGI   LC: UVF SLU   VC: SVD   GD: GND   TT: POS TAB   AW: AUA   CW: CUR   BQ: BON
MQ: FDF   GP: PTP   KN: SKB NEV   DM: DOM   GY: GEO
CO: BOG CTG MDE   PE: LIM   EC: UIO GYE   CL: SCL   AR: EZE   BR: GRU GIG   VE: CCS
GB: LHR LGW MAN EDI GLA BHX LTN STN   IE: DUB SNN   FR: CDG ORY LYS NCE TLS MRS BOD NTE
DE: FRA MUC TXL BER DUS HAM   IT: FCO MXP VCE NAP CTA BLQ PMO BRI   ES: MAD BCN AGP PMI
PT: LIS OPO PDL FAO TER   NL: AMS   BE: BRU LGG   CH: ZRH GVA BSL   AT: VIE   CZ: PRG   HU: BUD   PL: WAW KRK
RO: OTP   GR: ATH   DK: CPH   SE: ARN   NO: OSL   IS: KEF   HR: ZAG SPU DBV   TR: IST   IL: TLV
MA: CMN   DZ: ALG   EG: CAI   QA: DOH   AE: DXB   SA: RUH JED   GH: ACC   NG: LOS
JP: NRT HND KIX   KR: ICN   CN: PEK PVG CAN   HK: HKG   TW: TPE   PH: MNL   TH: BKK   SG: SIN QPG   VN: SGN
IN: DEL BOM   AU: SYD BNE MEL   NZ: AKL`;
const OTHER_COUNTRY = new Map();
for (const part of OTHER.trim().split(/\s{3,}|\n/)) {
  const m = part.trim().match(/^([A-Z]{2}):\s*(.*)$/);
  if (!m) continue;
  for (const code of m[2].split(/\s+/).filter(Boolean)) OTHER_COUNTRY.set(code, m[1]);
}

// Countries inside the Overseas Route Map line.
const DOMESTIC_COUNTRIES = new Set(['CA', 'US', 'MX', 'GT', 'BZ', 'SV', 'HN', 'NI', 'CR', 'CU', 'JM', 'BS', 'KY', 'BM', 'PM']);

/** ISO country code of an airport, or '' when unknown. */
export function countryOf(code) {
  if (!code) return '';
  const c = String(code).toUpperCase();
  if (OTHER_COUNTRY.has(c)) return OTHER_COUNTRY.get(c);
  if (US_CODES.has(c) || US_Y_CODES.has(c)) return 'US';
  if (c.startsWith('Y') || CA_OTHER.has(c)) return 'CA';
  return '';
}

/**
 * Inside the Overseas Route Map line?  true / false, or null when the airport is unknown
 * (unknown stations are treated as overseas by the engine, with a note).
 */
export function isDomestic(code) {
  const c = String(code || '').toUpperCase();
  if (HAWAII.has(c)) return false;
  const k = countryOf(c);
  if (!k) return null;
  return DOMESTIC_COUNTRIES.has(k);
}

const NAMES = {
  CA: 'Canada', US: 'United States', MX: 'Mexico', CU: 'Cuba', JM: 'Jamaica', BS: 'Bahamas', DO: 'Dominican Republic',
  PR: 'Puerto Rico', GB: 'United Kingdom', FR: 'France', DE: 'Germany', IT: 'Italy', ES: 'Spain', PT: 'Portugal',
};
export const countryName = (iso) => NAMES[iso] || iso || 'Unknown';
