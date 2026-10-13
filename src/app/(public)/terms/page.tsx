import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getBranding } from '@/lib/branding/service'

export function generateMetadata(): Metadata {
  return {
    title: `Användarvillkor - ${getBranding().appName}`,
  }
}

export default function TermsPage() {
  const { appName, legalEntity, supportEmail } = getBranding()
  return (
    <div className="min-h-dvh bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">
            Användarvillkor
          </h1>
          <p className="text-muted-foreground">
            Senast uppdaterad: 2026-06-19
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Tjänsten</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              {appName} är ett bokföringsverktyg som tillhandahålls av {legalEntity}.
              Tjänsten hjälper dig att sköta löpande bokföring, fakturering, moms och
              rapportering i enlighet med svensk bokföringslagstiftning. Genom att
              använda {appName} godkänner du dessa villkor.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Ditt ansvar</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <ul>
              <li>Du ansvarar för att de uppgifter du registrerar är korrekta och fullständiga.</li>
              <li>Du ansvarar för att din användning av tjänsten följer tillämplig lag, inklusive Bokföringslagen.</li>
              <li>Du ansvarar för att hålla dina inloggningsuppgifter säkra och inte dela dem med obehöriga.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Bankkoppling (PSD2)</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              {appName} kan kopplas till ditt bankkonto via en licensierad
              tredjepartsleverantör för kontoinformationstjänster (PSD2). Kopplingen
              är frivillig, kräver ditt uttryckliga samtycke i bankens egen inloggning
              och används enbart för att hämta saldon och transaktioner till din
              bokföring. Du kan när som helst återkalla samtycket.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4. Personuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Hur vi behandlar personuppgifter beskrivs i vår{' '}
              <Link href="/privacy" className="text-primary underline underline-offset-4">
                integritetspolicy
              </Link>
              {' '}och, i förekommande fall, vårt{' '}
              <Link href="/dpa" className="text-primary underline underline-offset-4">
                personuppgiftsbiträdesavtal
              </Link>.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>5. Ansvarsbegränsning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Tjänsten tillhandahålls i befintligt skick. Du är själv ansvarig för
              att granska och godkänna det som bokförs samt för att deklarationer och
              rapporter lämnas in i tid. {legalEntity} ansvarar inte för indirekta
              skador som följer av användningen av tjänsten, i den utsträckning lagen
              tillåter.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>6. Ändringar och uppsägning</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <p>
              Vi kan uppdatera dessa villkor och tjänstens funktioner över tid.
              Väsentliga ändringar meddelas i appen. Du kan när som helst sluta använda
              tjänsten. Bokföringsmaterial bevaras enligt de lagstadgade arkiveringskrav
              som beskrivs i integritetspolicyn.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>7. Kontakt</CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm max-w-none">
            <ul>
              <li><strong>Företag:</strong> {legalEntity}</li>
              <li><strong>E-post:</strong> {supportEmail}</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
