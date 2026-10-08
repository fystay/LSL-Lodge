/** Formats integer minor units, e.g. 12345 GBP → "£123.45". */
export function formatMoney(minor: number, currency = "GBP"): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}
