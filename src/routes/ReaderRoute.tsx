import { useParams } from 'react-router';
import { Reader } from '../features/reader/Reader';

export function ReaderRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <main className="page">No text selected.</main>;
  return <Reader docId={id} />;
}
