import { notFound } from "next/navigation";

import { verifyHtmlAppToken } from "@/server/html-apps/sign-token";
import { getHtmlApp } from "@/server/html-apps/store";
import { sharedRedisState } from "@/server/state";

import type { Metadata } from "next";

interface HtmlAppPageProps {
  params: Promise<{ token: string }>;
}

export const dynamic = "force-dynamic";

const loadHtmlAppFromToken = async (token: string) => {
  const secret = process.env.SLACK_ENCRYPTION_KEY;
  if (!secret) return null;

  const verified = verifyHtmlAppToken({ token, secret });
  if (!verified) return null;

  return getHtmlApp(sharedRedisState, verified.teamId, verified.id);
};

export const generateMetadata = async ({
  params,
}: HtmlAppPageProps): Promise<Metadata> => {
  const { token } = await params;
  const row = await loadHtmlAppFromToken(token);
  if (!row) return { title: "Pookie app" };
  return {
    title: row.title,
    description: row.description,
    robots: { index: false, follow: false },
  };
};

const HtmlAppPage = async ({ params }: HtmlAppPageProps) => {
  const { token } = await params;
  const row = await loadHtmlAppFromToken(token);
  if (!row) notFound();

  return (
    <main className="fixed inset-0 flex h-screen w-screen flex-col bg-white">
      <iframe
        title={row.title}
        srcDoc={row.html}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="h-full w-full grow border-0"
      />
    </main>
  );
};

export default HtmlAppPage;
