# Privacy Policy

Effective date: May 22, 2026

This privacy policy explains how RDOC-LRC ("Raumdock Long Range Communication") processes personal data when the Discord bridge bot and optional web admin interface are used.

This document is a template for the operator of this RDOC-LRC instance. Replace the placeholders before publishing.

## 1. Controller

Controller:

`Torsten Ennenbach / raumdock.org`  
`c/o Online-Impressum.de #4910`
`Europaring 90`  
`53757 Sankt Augustin, Germany`  
`tower@raumdock.org`


## 2. What RDOC-LRC Does

RDOC-LRC connects selected Discord text channels across different Discord servers. Messages posted in one linked channel may be relayed to other linked channels in the same bridge room by webhook.

Access to bridge rooms is controlled by operator-issued one-time tokens. The optional web interface is used by authorised administrators to manage rooms, tokens, users, audit logs, and moderation settings.

## 3. Personal Data We Process

Depending on how the service is used, RDOC-LRC may process:

- Discord user ID
- Discord username, global name, display name, and avatar URL
- Discord server ID, server name, channel ID, and channel name
- Message content posted in linked bridge channels
- Message attachments and attachment URLs
- Webhook IDs and webhook URLs required to relay messages
- Join/kick tokens and token metadata, including room name, guild binding, expiry, creation time, and consumption status
- Moderation data, including room bans, bad-word filter configuration, weblink allowlists, and mention-mode settings
- Audit log entries, including administrative actions, token use, moderation events, webhook errors, timestamps, and involved Discord IDs
- Web admin login data from Discord OAuth, including Discord user ID and display information returned by Discord
- Session cookies and CSRF tokens for the web admin interface
- Technical logs required to operate and troubleshoot the service

RDOC-LRC does not intentionally collect payment data or government identification documents.

## 4. Purposes of Processing

We process personal data to:

- Relay messages between authorised bridge channels
- Display the original source server and sender name for relayed messages
- Manage room membership and webhook delivery
- Issue, validate, consume, and revoke one-time access tokens
- Provide administrator access to the web interface
- Enforce moderation settings, bans, bad-word filters, and weblink rules
- Record audit events for security, abuse prevention, and operational accountability
- Troubleshoot delivery failures, configuration problems, and abuse reports
- Maintain the security and reliability of the service

## 5. Legal Bases

Where the GDPR applies, processing is based on one or more of the following legal bases:

- **Legitimate interests**: operating a cross-server Discord bridge, preventing abuse, maintaining audit logs, and securing the service.
- **Contract or pre-contractual necessity**: providing the requested bridge functionality to participating communities, where applicable.
- **Consent**: where a specific feature or community rule requires consent.
- **Legal obligation**: where retention or disclosure is required by applicable law.

The exact legal basis may depend on the operator, the participating Discord communities, and the local legal context.

## 6. Message Relay and Visibility

Messages posted in a linked bridge channel may be copied to other Discord channels in the same bridge room. Relayed messages may include the sender's display name, avatar, message text, and attachments.

Users should treat linked bridge channels as shared spaces. A message sent in one linked channel can become visible to members of other participating Discord servers.

## 7. Web Admin Interface

The optional web admin interface uses Discord OAuth for sign-in. Only authorised Discord user IDs can access the interface.

The web interface uses session cookies and CSRF tokens to keep administrators signed in and to protect forms against cross-site request forgery. Cookies are used only for authentication and security of the admin interface.

## 8. Recipients and Processors

Personal data may be processed by:

- The RDOC-LRC operator and authorised administrators
- Discord, because the service runs on Discord and uses Discord APIs, OAuth, channels, messages, webhooks, and attachments
- Infrastructure providers used by the operator, such as hosting, reverse proxy, DNS, logging, backup, or container services

The operator is responsible for ensuring that any processors used for hosting or administration provide appropriate safeguards.

## 9. International Transfers

Discord and infrastructure providers may process data outside the European Economic Area. Where required, transfers should rely on appropriate safeguards such as adequacy decisions, standard contractual clauses, or other lawful mechanisms.

The operator should document the actual providers and transfer mechanisms used for this instance.

## 10. Retention

Retention depends on the type of data:

- Relayed Discord messages remain in Discord channels until deleted according to Discord server rules or Discord retention behaviour.
- Room membership and webhook configuration are stored while a channel remains linked.
- Tokens are stored until consumed, revoked, expired, or cleaned up.
- Audit logs are retained for operational security and abuse investigation. The application caps stored audit entries, but the operator should define a concrete retention period.
- Moderation settings and room bans are retained until changed or removed by an administrator.
- Web sessions expire according to the session configuration or when cleared by the user/operator.
- Technical logs are retained only as long as needed for operations, debugging, and security.

Recommended operator setting:

`audit logs: 90 days, technical logs: 30 days`

## 11. Security Measures

RDOC-LRC includes security controls such as:

- Operator-issued one-time join and kick tokens
- Token expiry and atomic token consumption
- Admin-only web routes for sensitive actions
- CSRF protection for web forms
- HttpOnly and SameSite session cookies
- Slash-command permission checks
- Operator-only controls for room-wide moderation settings
- Disabled mention parsing for relayed messages by default
- Audit logging for sensitive actions and failures
- Redis-backed state storage

The operator should also secure the host system, Discord bot token, OAuth secrets, Cloudflare/API tokens, Redis access, backups, and reverse proxy configuration.

## 12. Your Rights

Where the GDPR applies, you may have the right to:

- Be informed about processing of your personal data
- Access your personal data
- Correct inaccurate or incomplete data
- Request deletion of your personal data
- Restrict processing
- Object to processing based on legitimate interests
- Receive certain data in a portable format
- Lodge a complaint with a competent data protection authority

To exercise these rights, contact:

`privacy@raumdock.org`

Because RDOC-LRC relays messages through Discord, some deletion or correction requests may also need to be handled directly in Discord by deleting or editing Discord messages, depending on where the data is stored.

## 13. Children

RDOC-LRC is intended for Discord communities and is not directed at children below the minimum age required by Discord or applicable law. Participating Discord servers are responsible for their own member access rules.

## 14. Changes to This Policy

The operator may update this privacy policy when the service, configuration, providers, or legal requirements change. The updated version should include a new effective date.

## 15. Contact

For privacy questions or requests:

`privacy@raumdock.org`

