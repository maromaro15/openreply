/** Brand voice of the active brand (lib/voice): its examples and dictionary. */
import VoiceManager from "@/components/facebook/voice-manager";
import { getCurrentWorkspaceContext, hasWorkspaceRole } from "@/lib/workspace-access";

export default async function BrandVoicePage() {
  const context = await getCurrentWorkspaceContext();
  return <VoiceManager canManage={context ? hasWorkspaceRole(context.role, "ADMIN") : false} />;
}
