# Intégrations externes et garde-fous

Le staging initial doit démarrer sans credentials fournisseurs ni effets externes. Activer une intégration uniquement avec sandbox documentée, responsable et contrôle anti-live.

| Domaine | Surface | Réglage initial sûr |
|---|---|---|
| M23/M41 clearinghouse | `CLEARINGHOUSE_VENDOR`, choix tenant, Claim.MD/Stedi, passerelle X12 | pas de vendor/credential ni config autorisant l’envoi |
| Claim.MD ERA | webhook, capture, attribution, livraison/posting | webhook false; autres flags absents/false |
| M24 Medicaid | `M24_LAUNCH_GATEWAY_ENABLED` et credentials trading partner | false sans sandbox confirmée |
| DoseSpot/M12 | registration tenant/credentials et gate production | ne pas activer registration de production |
| Stripe/M35 | `STRIPE_SECRET_KEY`, webhook, API base URL | aucun secret live; test mode après validation |
| Courriel/SMS/voix/push | Postmark, Twilio, VAPID, FCM/APNs | sink/destinataires internes consentis |
| EVV, télésanté, fax, géocode, IA | credentials/endpoints spécialisés | désactivés ou sandbox; pas de données réelles |
| HL7/FHIR | listeners et configurations | ports privés; payloads synthétiques |

Les valeurs effectives/flags d’un hôte sont inconnus; aucun secret réel consulté. Une validation de lancement doit refuser credentials/destinations prod au niveau configuration et réseau. Les anciens rapports BIL sont des indices d’ingénierie, pas preuve du runtime actuel. Aucun rejeu clearinghouse, post financier ou prescription réelle n’est autorisé par ce rapport.
