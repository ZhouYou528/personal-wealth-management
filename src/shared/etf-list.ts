// Known ETF tickers. IBKR's Flex Query and SnapTrade both classify ETFs as
// generic "stock" in their asset categories, so we need this whitelist to
// correctly tag them as `etf` for filtering / allocation logic.

export const ETF_SYMBOLS = new Set([
  // US-listed
  'SPY','QQQ','QQQM','IVV','VOO','VTI','VEA','VWO','GLD','SLV','TLT','HYG','LQD',
  'ARKK','ARKG','ARKW','XLF','XLE','XLK','XLV','SCHD','VNQ','JEPI','JEPQ','BIL','SGOV',
  'TQQQ','SQQQ','UPRO','SPXL','SOXL','SOXS','TLT','IEF','BND',
  // TSX-listed (Canadian)
  'XEQT','VEQT','XIC','VFV','VCN','XIU','XGRO','XBAL','VBAL','VGRO',
  'CBIL','HISA','CASH','QQC','ZSP','ZAG','XAW','VAB','VEE','VIU',
])

export function isEtfSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false
  return ETF_SYMBOLS.has(symbol.toUpperCase())
}

// 401k / pension plan target-date funds and CITs — these don't have intraday
// prices, so they must be tagged `mutual_fund` to bypass live-quote lookup.
// Plan-specific tickers (like Fidelity's "O24K" alias for Vanguard 2060) live
// here too since SnapTrade reports them as generic "stock".
export const MUTUAL_FUND_SYMBOLS = new Set([
  'O24K',              // Vanguard Target Retirement 2060 (Fidelity 401k alias)
  'BLKLP2060',         // BlackRock LifePath 2060 (Fidelity 401k alias)
  'VTTSX','VFFVX','VTHRX','VFORX','VTIVX','VTWNX','VTXVX','VTRRX',  // Vanguard Target Retirement series
  'LIPKX','LIPLX','LIPMX','LIPNX','LIPOX','LIPPX',                  // BlackRock LifePath series
])

export function isMutualFundSymbol(symbol: string | null | undefined): boolean {
  if (!symbol) return false
  return MUTUAL_FUND_SYMBOLS.has(symbol.toUpperCase())
}
