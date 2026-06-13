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
