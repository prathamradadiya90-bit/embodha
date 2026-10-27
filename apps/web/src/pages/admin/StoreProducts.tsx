import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { StoreLink, StoreProductStatus, StoreProducts as Data } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Badge, Button, Card, CourseStatusBadge, Empty, ErrorNote, Loading, PageHeader } from '../../ui/kit';

type Store = 'apple' | 'google';
type Owner = { ownerType: 'course' | 'instructor_plan'; ownerId: string };

const PRODUCT_ID = /^[a-z0-9][a-z0-9._]{1,99}$/;
const statusName: Record<StoreProductStatus, string> = { pending: 'Setting up', in_review: 'In review', live: 'Live', failed: 'Problem', off_sale: 'Off sale' };
const statusTone: Record<StoreProductStatus, 'neutral' | 'amber' | 'green' | 'red'> = { pending: 'neutral', in_review: 'amber', live: 'green', failed: 'red', off_sale: 'neutral' };
const storeNames = (on: Data['automation']) => [on.apple ? 'the App Store' : '', on.google ? 'Google Play' : ''].filter(Boolean).join(' and ');

/**
 * Inside the iPhone and Android apps, Apple and Google do the selling. Each course and each instructor's subscription
 * needs a product made by hand in App Store Connect and Play Console; this page links those products to the catalogue.
 */
export function StoreProducts() {
  const query = useQuery({
    queryKey: ['admin', 'store-products'],
    queryFn: () => api<Data>('/v1/admin/store-products'),
    refetchInterval: (q) => (q.state.data?.working.length ? 3000 : false), // while the server is making products
  });
  const sweep = useAction();
  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorNote error={query.error} />;
  const { courses, plans, commissionBps, automation, working } = query.data;
  const auto = automation.apple || automation.google;

  return (
    <div className="stack">
      <PageHeader
        title="Store products"
        lead={`In the phone apps, Apple and Google sell the courses and subscriptions and keep ${commissionBps / 100}% of each sale before GST. A course gets a buy button in the app once its product here is in review or live.`}
        actions={
          auto ? (
            <Button variant="secondary" busy={sweep.busy} onClick={() => void sweep.run(() => api('/v1/admin/store-products/sweep', { method: 'POST' }))}>
              Check on everything now
            </Button>
          ) : null
        }
      />
      <ErrorNote error={sweep.error} />
      {auto ? (
        <div className="notice small">
          The server makes the products in {storeNames(automation)} itself: when a course is published, and when a teacher switches their subscription on
          or changes its price. It prices them from the catalogue, asks for Apple's review, and takes them off sale when a course is archived or a
          subscription is switched off. It retries anything that failed and checks on Apple's review every half hour.
          {automation.apple && automation.google ? null : ` The other store isn't connected, so link its products by hand.`} Products linked by hand stay
          as they are.
        </div>
      ) : null}
      <div className="notice small" hidden={auto && automation.apple && automation.google}>
        Make each product in App Store Connect (a non-consumable for a course, an auto-renewing subscription for a teacher) and in Play Console (a one-time
        product, or a subscription with one monthly base plan), using the ID below and the same price in rupees and dollars. Give every teacher their own
        subscription group in App Store Connect, so a member can subscribe to more than one. An ID can never be reused in either store, even after it's deleted.
      </div>

      <Card title="Courses">
        {courses.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Course</th>
                  <th>App Store</th>
                  <th>Google Play</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((course) => (
                  <tr key={course.id}>
                    <td style={{ minWidth: 200, maxWidth: 280 }}>
                      <strong>{course.title}</strong>
                      <div className="small muted">{course.instructor}</div>
                      <div className="small muted">{course.price ? `${course.price.inr} · ${course.price.usd}` : 'No price set'}</div>
                      {course.status !== 'published' ? <CourseStatusBadge status={course.status} /> : null}
                      <MakeButton owner={{ ownerType: 'course', ownerId: course.id }} links={[course.apple, course.google]} automation={automation} working={working} />
                    </td>
                    <td>
                      <StoreCell owner={{ ownerType: 'course', ownerId: course.id }} store="apple" linked={course.apple} suggestedId={course.suggestedId} />
                    </td>
                    <td>
                      <StoreCell owner={{ ownerType: 'course', ownerId: course.id }} store="google" linked={course.google} suggestedId={course.suggestedId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No paid courses yet. Free courses don't need store products.</Empty>
        )}
      </Card>

      <Card title="Teachers' monthly subscriptions">
        {plans.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>App Store</th>
                  <th>Google Play</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.instructorId}>
                    <td style={{ minWidth: 200, maxWidth: 280 }}>
                      <strong>{plan.displayName}</strong>
                      <div className="small muted">{plan.price ? `${plan.price.inr} · ${plan.price.usd} a month` : 'No price set'}</div>
                      {plan.enabled ? null : (
                        <div className="small muted">
                          {plan.apple?.auto
                            ? 'Switched off in the studio, so the server took it off sale in both stores. App Store subscribers stop at their next renewal date.'
                            : 'Switched off in the studio. Google Play renewals were stopped then; take it off sale in App Store Connect so App Store subscribers stop renewing too.'}
                        </div>
                      )}
                      <MakeButton owner={{ ownerType: 'instructor_plan', ownerId: plan.instructorId }} links={[plan.apple, plan.google]} automation={automation} working={working} />
                    </td>
                    <td>
                      <StoreCell owner={{ ownerType: 'instructor_plan', ownerId: plan.instructorId }} store="apple" linked={plan.apple} suggestedId={plan.suggestedId} />
                    </td>
                    <td>
                      <StoreCell owner={{ ownerType: 'instructor_plan', ownerId: plan.instructorId }} store="google" linked={plan.google} suggestedId={plan.suggestedId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No teacher has switched on a monthly subscription yet.</Empty>
        )}
      </Card>
    </div>
  );
}

/** Starts (or restarts) the server making this row's products. Shown when a connected store has none, or one failed. */
function MakeButton({ owner, links, automation, working }: { owner: Owner; links: (StoreLink | null)[]; automation: Data['automation']; working: string[] }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [apple, google] = links;
  const needed = (automation.apple && (!apple || (apple.auto && apple.status === 'failed'))) || (automation.google && (!google || (google.auto && google.status === 'failed')));
  if (working.includes(owner.ownerId)) return <div className="small muted" style={{ marginTop: 8 }}>Making it in the stores…</div>;
  if (!needed) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <Button
        variant="secondary"
        busy={action.busy}
        onClick={() =>
          void action.run(async () => {
            await api('/v1/admin/store-products/sync', { method: 'POST', body: owner });
            await queryClient.invalidateQueries({ queryKey: ['admin', 'store-products'] });
          })
        }
      >
        {[apple, google].some((l) => l?.auto && l.status === 'failed') ? 'Try again' : 'Make in the stores'}
      </Button>
      <ErrorNote error={action.error} />
    </div>
  );
}

function StoreCell(props: { owner: Owner; store: Store; linked: StoreLink | null; suggestedId: string }) {
  return props.linked?.auto ? <MadeByServer link={props.linked} /> : <LinkedByHand {...props} />;
}

/** A product the server made: what it is and where it stands, nothing to edit. */
function MadeByServer({ link }: { link: StoreLink }) {
  return (
    <div className="stack" style={{ gap: 6, minWidth: 230 }}>
      <div className="row" style={{ gap: 6 }}>
        <Badge tone={statusTone[link.status]}>{statusName[link.status]}</Badge>
        <span className="small muted">made by the server</span>
      </div>
      <code style={{ fontSize: 13 }}>{link.productId}</code>
      {link.storeState ? <span className="small muted">{link.storeState.toLowerCase().replace(/_/g, ' ')}</span> : null}
      {link.note ? <span className="small">{link.note}</span> : null}
    </div>
  );
}

function LinkedByHand({ owner, store, linked, suggestedId }: { owner: Owner; store: Store; linked: StoreLink | null; suggestedId: string }) {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState(linked?.productId ?? suggestedId);
  const [status, setStatus] = useState<StoreProductStatus>(linked?.status ?? 'pending');
  const [note, setNote] = useState(linked?.note ?? '');
  const action = useAction();
  const storeName = store === 'apple' ? 'App Store' : 'Google Play';
  const valid = PRODUCT_ID.test(productId.trim());
  const changed = !linked || productId.trim() !== linked.productId || status !== linked.status || (status === 'failed' && note.trim() !== (linked.note ?? ''));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'store-products'] });

  const save = () =>
    action.run(async () => {
      await api('/v1/admin/store-products', {
        method: 'PUT',
        body: { ...owner, store, productId: productId.trim(), status, note: status === 'failed' ? note.trim() : undefined },
      });
      await refresh();
    });
  const unlink = () => {
    if (!linked || !window.confirm(`Unlink ${linked.productId} from ${storeName}? The app stops offering it; anyone who bought it keeps it.`)) return;
    void action.run(async () => {
      await api(`/v1/admin/store-products/${linked.id}`, { method: 'DELETE' });
      setStatus('pending');
      await refresh();
    });
  };

  return (
    <div className="stack" style={{ gap: 6, minWidth: 230 }}>
      <div className="row" style={{ gap: 6 }}>
        {linked ? <Badge tone={statusTone[linked.status]}>{statusName[linked.status]}</Badge> : <span className="small muted">Not linked</span>}
      </div>
      <input
        aria-label={`${storeName} product ID`}
        value={productId}
        onChange={(e) => setProductId(e.target.value.toLowerCase())}
        spellCheck={false}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
      />
      <select aria-label={`${storeName} status`} value={status} onChange={(e) => setStatus(e.target.value as StoreProductStatus)}>
        {(Object.keys(statusName) as StoreProductStatus[]).map((value) => (
          <option key={value} value={value}>
            {statusName[value]}
          </option>
        ))}
      </select>
      {status === 'failed' ? (
        <textarea
          aria-label="What went wrong"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What went wrong? Rejected in review, wrong price…"
          maxLength={300}
          style={{ minHeight: 64 }}
        />
      ) : null}
      <div className="row" style={{ gap: 4 }}>
        {changed ? (
          <Button variant="secondary" busy={action.busy} disabled={!valid} onClick={() => void save()}>
            {linked ? 'Save' : 'Link'}
          </Button>
        ) : null}
        {linked ? (
          <Button variant="quiet" onClick={unlink}>
            Unlink
          </Button>
        ) : null}
      </div>
      {!valid && productId ? <span className="small muted">Lowercase letters, digits, dots and underscores.</span> : null}
      <ErrorNote error={action.error} />
    </div>
  );
}
