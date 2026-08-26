import { redirect } from '@/i18n/routing';

export default async function Page(props: { params: Promise<{ locale: string }> }) {
  const params = await props.params;
  redirect({ href: '/zk', locale: params.locale });
}
