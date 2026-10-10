import { formatStayDate, type IsoDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import type { Quote } from "@/server/pricing/quote";

const purposeLabel = {
  FULL: "Full payment",
  DEPOSIT: "Deposit",
  BALANCE: "Balance",
} as const;

/**
 * Itemised price and payment schedule. Every mandatory charge is shown.
 * `dueLabels` overrides the due text per schedule sequence.
 */
export function QuoteSummary({
  quote,
  today,
  dueLabels,
}: {
  quote: Quote;
  today?: IsoDate;
  dueLabels?: Partial<Record<number, string>>;
}) {
  const money = (minor: number) => formatMoney(minor, quote.currency);
  return (
    <div className="space-y-6">
      <table className="w-full text-left">
        <caption className="sr-only">Price breakdown</caption>
        <tbody className="divide-y divide-sage-300/70">
          {quote.lines.map((line) => (
            <tr key={`${line.kind}-${line.label}`}>
              <th scope="row" className="py-2.5 font-normal">
                {line.label}
              </th>
              <td className="py-2.5 text-right tabular-nums">
                {money(line.amountMinor)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-pine-900">
            <th scope="row" className="pt-3 font-semibold text-pine-900">
              Total
            </th>
            <td className="pt-3 text-right text-lg font-semibold text-pine-900 tabular-nums">
              {money(quote.totalMinor)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="text-sm text-ink-muted">
        Prices are in pounds sterling and include every mandatory fee.{" "}
        {quote.taxUnconfirmed
          ? "Tax treatment is still being confirmed by the owner."
          : null}
      </p>

      <div>
        <h3 className="font-sans text-base font-semibold text-pine-900">
          Payment schedule
        </h3>
        <ul className="mt-2 divide-y divide-sage-300/70">
          {quote.schedule.map((item) => (
            <li
              key={item.sequence}
              className="flex justify-between gap-4 py-2.5"
            >
              <span>
                {purposeLabel[item.purpose]}{" "}
                <span className="text-ink-muted">
                  {dueLabels?.[item.sequence] ??
                    (today && item.dueOn <= today
                      ? "due now"
                      : `due by ${formatStayDate(item.dueOn as IsoDate)}`)}
                </span>
              </span>
              <span className="tabular-nums">{money(item.amountMinor)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
