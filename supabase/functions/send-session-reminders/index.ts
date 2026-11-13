import { createClient } from "npm:@supabase/supabase-js@2";

type Reminder = {
  claimed_session_id: string;
  claimed_lead_minutes: number;
  claimed_session_start_at: string;
  student_email: string;
  student_name: string;
  subject_name: string;
  session_start_at: string;
  session_timezone: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const cronSecret = Deno.env.get("REMINDER_CRON_SECRET");
const fromEmail = Deno.env.get("REMINDER_FROM_EMAIL");

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function formatSessionDate(startAt: string, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "full",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : { timeZone: "UTC" }),
  };
  try {
    return new Intl.DateTimeFormat("fr-FR", options).format(new Date(startAt));
  } catch {
    return `${new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(startAt))} UTC`;
  }
}

Deno.serve(async request => {
  if (request.method !== "POST") {
    return new Response("Méthode non autorisée", { status: 405 });
  }
  if (!cronSecret || request.headers.get("x-reminder-secret") !== cronSecret) {
    return new Response("Non autorisé", { status: 401 });
  }
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !fromEmail) {
    console.error("Configuration des rappels incomplète.");
    return new Response("Configuration des rappels incomplète", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: reminders, error: claimError } = await supabase.rpc(
    "claim_due_session_reminders",
  );
  if (claimError) {
    console.error("Impossible de récupérer les rappels à envoyer.", claimError);
    return new Response("Impossible de récupérer les rappels", { status: 500 });
  }

  let sent = 0;
  let failed = 0;
  for (const reminder of (reminders ?? []) as Reminder[]) {
    const when = formatSessionDate(reminder.session_start_at, reminder.session_timezone);
    const lead = reminder.claimed_lead_minutes === 1440 ? "24 heures" : "2 heures";
    const subject = "Rappel de votre séance";
    const html = `<p>Bonjour ${escapeHtml(reminder.student_name)},</p>
      <p>Petit rappel envoyé environ ${lead} avant votre séance de
      <strong>${escapeHtml(reminder.subject_name)}</strong>, prévue le
      <strong>${escapeHtml(when)}</strong>.</p>
      <p>À bientôt !</p>`;

    let deliveryError: string | null = null;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [reminder.student_email],
          subject,
          html,
        }),
      });
      if (!response.ok) deliveryError = `Resend a répondu HTTP ${response.status}`;
    } catch (error) {
      deliveryError = error instanceof Error ? error.message : "Erreur réseau inconnue";
    }

    const status = deliveryError ? "failed" : "sent";
    const { error: updateError } = await supabase
      .from("session_reminders")
      .update({
        status,
        updated_at: new Date().toISOString(),
        last_error: deliveryError,
      })
      .eq("session_id", reminder.claimed_session_id)
      .eq("lead_minutes", reminder.claimed_lead_minutes)
      .eq("session_start_at", reminder.claimed_session_start_at);
    if (updateError) {
      console.error("Impossible d'enregistrer le résultat d'un rappel.", updateError);
      failed++;
    } else if (deliveryError) {
      console.error("Échec d'envoi d'un rappel.", deliveryError);
      failed++;
    } else {
      sent++;
    }
  }

  return Response.json({ sent, failed }, { status: failed ? 502 : 200 });
});
