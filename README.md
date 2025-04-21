RustyDegen
Therefore, the most effective mitigations are primarily at the infrastructure/network level, combined with careful input validation where possible:

Network Segmentation / Firewalling (Infrastructure Level - HIGHLY Recommended):

Configure firewall rules for the server running your Node.js application.
Block Egress Traffic: Deny all outgoing network connections by default.
Allowlist Specific Destinations: Explicitly allow outgoing connections only to the hosts absolutely necessary for your application:
Steam API endpoints (api.steampowered.com, steamcommunity.com)
Your database host (if external)
The pricing API host (rust.scmm.app)
Any other essential external services.
Crucially, block requests to:
Internal network IP ranges (e.g., 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.1).
Cloud provider metadata endpoints (e.g., 169.254.169.254).
Impact: This directly prevents the request library, even if exploited, from reaching sensitive internal resources or metadata services, drastically reducing the impact of an SSRF attack.
Egress Proxy (Infrastructure Level - Alternative/Complementary):

Route all outbound HTTP/S traffic from your Node.js application through a dedicated, explicitly configured proxy server.
Configure the proxy to only allow requests to the known, required external domains (Steam APIs, pricing API, etc.) and deny everything else.
Impact: Similar to firewalling, prevents requests to unintended destinations.
Input Validation (Application Level - Limited Scope for this case):

Review your server.js code anywhere you pass data into methods provided by steamcommunity or steam-tradeoffer-manager.
If any user-provided input could ever influence a URL or part of a request made by these libraries (this is less likely the main vector, but possible), validate it rigorously.
Use allowlists for characters/formats.
Never directly trust user input for URLs or hostnames.
Use libraries like express-validator (which you already have) for any relevant API inputs you control.
Limitation: This won't protect against SSRF triggered by the library fetching standard Steam resources using internally constructed URLs.
Least Privilege (Operating System Level):

Run your Node.js process under a dedicated user account with the minimum necessary permissions, especially regarding network access.
