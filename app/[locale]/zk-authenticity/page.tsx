import { redirect } from '@/i18n/routing';

// Legacy route: consolidated into /zk. Preserved as a redirect so old bookmarks
// and inbound links still resolve. The nested /zk/authenticity path never
// shipped as a real page — redirect goes to /zk directly.
export default async function Page(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  redirect({ href: '/zk', locale: params.locale });
}
