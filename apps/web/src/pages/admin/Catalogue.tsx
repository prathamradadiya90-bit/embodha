import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { CatalogueCategory } from '../../lib/types';
import { useAction } from '../../lib/useAction';
import { Button, Card, ErrorNote, Field, Loading, PageHeader, Toggle } from '../../ui/kit';

export function Catalogue() {
  const query = useQuery({ queryKey: ['admin', 'catalogue'], queryFn: () => api<CatalogueCategory[]>('/v1/admin/catalogue') });
  return (
    <div className="stack">
      <PageHeader
        title="Catalogue"
        lead="Categories and topics as members see them in Explore. New categories start hidden, so nobody lands on an empty one. Switch one on once it has topics and courses."
      />
      <AddForm label="New category" placeholder="e.g. Sleep" path="/v1/admin/categories" body={(name) => ({ name })} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorNote error={query.error} />
      ) : (
        <div className="grid-2">
          {query.data.map((category) => (
            <CategoryCard key={category.id} category={category} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryCard({ category }: { category: CatalogueCategory }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const patch = (path: string, body: object) =>
    action.run(async () => {
      await api(path, { method: 'PATCH', body });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'catalogue'] });
    });

  return (
    <Card
      title={category.name}
      actions={<Toggle checked={category.active} disabled={action.busy} onChange={(active) => void patch(`/v1/admin/categories/${category.id}`, { active })} label={category.active ? 'Shown' : 'Hidden'} />}
    >
      <div className="stack" style={{ gap: 10 }}>
        {category.topics.map((topic) => (
          <div key={topic.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              {topic.name} <span className="small muted">· {topic.courses ? `${topic.courses} ${topic.courses === 1 ? 'course' : 'courses'}` : 'no courses yet'}</span>
            </span>
            <Toggle checked={topic.active} disabled={action.busy} onChange={(active) => void patch(`/v1/admin/topics/${topic.id}`, { active })} label={topic.active ? 'Shown' : 'Hidden'} />
          </div>
        ))}
        <ErrorNote error={action.error} />
        <AddForm label="New topic" placeholder="e.g. Yoga nidra" path="/v1/admin/topics" body={(name) => ({ categoryId: category.id, name })} compact />
      </div>
    </Card>
  );
}

function AddForm({ label, placeholder, path, body, compact }: { label: string; placeholder: string; path: string; body: (name: string) => object; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const action = useAction();
  const form = (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action
          .run(async () => {
            await api(path, { method: 'POST', body: body(name.trim()) });
            await queryClient.invalidateQueries({ queryKey: ['admin', 'catalogue'] });
          })
          .then((ok) => ok && setName(''));
      }}
    >
      <Field label={label}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={60} />
      </Field>
      <Button type="submit" variant="secondary" busy={action.busy} disabled={name.trim().length < 2}>
        Add
      </Button>
      <ErrorNote error={action.error} />
    </form>
  );
  return compact ? form : <Card>{form}</Card>;
}
