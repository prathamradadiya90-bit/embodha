import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { useAction } from '../../lib/useAction';
import { Button, Card, ErrorNote, Field, Loading, PageHeader } from '../../ui/kit';

interface Settings {
  usdInrRate: number;
  refundWindowDays: number;
  minPayoutPaise: number;
  defaultShareBps: number;
  storeCommissionBps: number;
  gstRateBps: number;
  seller: { name: string; address: string; gstin: string; sac: string };
  /** The state the GSTIN is registered in, e.g. "Karnataka (29)". */
  sellerState: string | null;
  noteIndia: string;
  noteAbroad: string;
}

/** Finance's dials. Changes apply from now on; payments already recorded keep the numbers they were booked with. */
export function MoneySettings() {
  const query = useQuery({ queryKey: ['admin', 'money-settings'], queryFn: () => api<Settings>('/v1/admin/money-settings') });
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  return <Form current={query.data} />;
}

function Form({ current }: { current: Settings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    usdInrRate: String(current.usdInrRate),
    refundWindowDays: String(current.refundWindowDays),
    minPayout: String(current.minPayoutPaise / 100),
    defaultShare: String(current.defaultShareBps / 100),
    storeCommission: String(current.storeCommissionBps / 100),
    sellerName: current.seller.name,
    sellerAddress: current.seller.address,
    gstin: current.seller.gstin,
    sac: current.seller.sac,
    noteIndia: current.noteIndia,
    noteAbroad: current.noteAbroad,
  });
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm({ ...form, [key]: e.target.value });
  };
  const save = () =>
    action
      .run(async () => {
        await api('/v1/admin/money-settings', {
          method: 'PUT',
          body: {
            usdInrRate: Number(form.usdInrRate),
            refundWindowDays: Number(form.refundWindowDays),
            minPayoutPaise: Math.round(Number(form.minPayout) * 100),
            defaultShareBps: Math.round(Number(form.defaultShare) * 100),
            storeCommissionBps: Math.round(Number(form.storeCommission) * 100),
            seller: { name: form.sellerName.trim(), address: form.sellerAddress.trim(), gstin: form.gstin.trim().toUpperCase(), sac: form.sac.trim() },
            noteIndia: form.noteIndia.trim(),
            noteAbroad: form.noteAbroad.trim(),
          },
        });
        await queryClient.invalidateQueries({ queryKey: ['admin', 'money-settings'] });
      })
      .then((ok) => ok && setSaved(true));

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <PageHeader title="Money settings" lead="Changes apply to payments from now on. Anything already recorded keeps the numbers it was booked with." />
      <Card title="Sales and payouts">
        <div className="form-grid">
          <Field label="Rupees per dollar" hint="Estimates a dollar sale until the channel says what it came to: Razorpay's conversion on a website payment, or the store's monthly report. A recent rate keeps the estimates close.">
            <input inputMode="decimal" value={form.usdInrRate} onChange={set('usdInrRate')} />
          </Field>
          <Field label="Refund window, in days" hint="Shares are paid out only after this.">
            <input inputMode="numeric" value={form.refundWindowDays} onChange={set('refundWindowDays')} />
          </Field>
          <Field label="Smallest payout, in rupees" hint="Smaller balances carry over to the next month.">
            <input inputMode="decimal" value={form.minPayout} onChange={set('minPayout')} />
          </Field>
          <Field label="Default share for new instructors, %" hint="Each instructor's own share is on the Instructors page.">
            <input inputMode="decimal" value={form.defaultShare} onChange={set('defaultShare')} />
          </Field>
          <Field label="App Store and Google Play commission, %" hint="Their cut of sales in the apps, on the price before GST. 15% in both small-business programmes.">
            <input inputMode="decimal" value={form.storeCommission} onChange={set('storeCommission')} />
          </Field>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>
          GST is {current.gstRateBps / 100}% on sales in India, included in the price.
        </p>
      </Card>
      <Card title="On every invoice">
        <div className="form-grid">
          <Field label="Seller's legal name">
            <input value={form.sellerName} onChange={set('sellerName')} maxLength={120} />
          </Field>
          <Field
            label="GSTIN"
            hint={
              current.sellerState && form.gstin.trim().toUpperCase() === current.seller.gstin
                ? `Registered in ${current.sellerState}. Buyers there pay CGST and SGST; everyone else in India pays IGST.`
                : "15 letters and digits. Leave it empty until it's registered; until then, GST goes on invoices in one piece."
            }
          >
            <input value={form.gstin} onChange={set('gstin')} maxLength={15} style={{ textTransform: 'uppercase' }} />
          </Field>
          <Field label="SAC" hint="The service code printed on invoices, such as 999293. Optional below ₹5 crore turnover; ask your accountant which one.">
            <input inputMode="numeric" value={form.sac} onChange={set('sac')} maxLength={8} />
          </Field>
        </div>
        <div className="stack" style={{ marginTop: 14 }}>
          <Field label="Address">
            <textarea value={form.sellerAddress} onChange={set('sellerAddress')} maxLength={400} />
          </Field>
          <Field label="Footnote on invoices to buyers in India" hint="Optional.">
            <input value={form.noteIndia} onChange={set('noteIndia')} maxLength={400} />
          </Field>
          <Field label="Footnote on invoices to buyers abroad" hint="For example, the LUT under which exports carry no GST. Ask your accountant for the exact wording.">
            <input value={form.noteAbroad} onChange={set('noteAbroad')} maxLength={400} />
          </Field>
        </div>
      </Card>
      <div className="row">
        <Button type="submit" busy={action.busy}>
          Save settings
        </Button>
        {saved ? <span className="small muted">Saved.</span> : null}
        <ErrorNote error={action.error} />
      </div>
    </form>
  );
}
