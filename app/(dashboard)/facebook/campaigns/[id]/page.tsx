"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import CampaignForm, { type CampaignFormValues } from "@/components/facebook/campaign-form";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type StoredCampaign = {
  name: string;
  facebookPageId: string;
  matchAnyPost: boolean;
  postId: string | null;
  postPermalink: string | null;
  postPreview: string | null;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  privateReplyMessage: string;
  buttonLabel: string;
  landingUrl: string;
  addUtm: boolean;
  publicReplyEnabled: boolean;
  publicReplyMessages: string[];
  botContext: string | null;
  isActive: boolean;
};

function toValues(campaign: StoredCampaign): CampaignFormValues {
  return {
    name: campaign.name,
    facebookPageId: campaign.facebookPageId,
    matchAnyPost: campaign.matchAnyPost,
    postId: campaign.postId ?? "",
    postPermalink: campaign.postPermalink ?? "",
    postPreview: campaign.postPreview ?? "",
    keywords: campaign.keywords,
    matchAnyWord: campaign.matchAnyWord,
    wholeWordMatch: campaign.wholeWordMatch,
    privateReplyMessage: campaign.privateReplyMessage,
    buttonLabel: campaign.buttonLabel,
    landingUrl: campaign.landingUrl,
    addUtm: campaign.addUtm,
    publicReplyEnabled: campaign.publicReplyEnabled,
    publicReplyText: campaign.publicReplyMessages.join("\n"),
    botContext: campaign.botContext ?? "",
    isActive: campaign.isActive,
  };
}

export default function EditFacebookCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useFbI18n();
  const [values, setValues] = useState<CampaignFormValues | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/facebook/campaigns/${id}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.success) setValues(toValues(payload.data.campaign));
        else setMissing(true);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (missing) return <p className="text-sm text-muted">{t("Campaign not found.")}</p>;
  if (!values) return <div className="panel h-64 rounded" />;
  return <CampaignForm campaignId={id} initial={values} />;
}
