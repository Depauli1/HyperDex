# HyperDex Relayer Production Setup Guide

This guide outlines the setup process for deploying the HyperDex Relayer in a production environment with high availability, load balancing, monitoring, and alerting.

## Architecture Overview

The production deployment architecture includes:

1. **Multiple Relayer Instances**: Three redundant instances for high availability
2. **Load Balancing**: NGINX for distributing traffic among instances
3. **Database**: PostgreSQL for transaction persistence and user data
4. **Caching and Rate Limiting**: Redis for distributed rate limiting and caching
5. **Monitoring**: Prometheus for metrics collection
6. **Visualization**: Grafana for dashboards and visualization
7. **Alerting**: Prometheus Alertmanager for notifications

## Prerequisites

- Docker and Docker Compose
- A server with at least 4GB RAM and 2 CPUs
- Domain name with SSL certificates
- Ethereum node access (multiple providers recommended)

## Environment Variables

Create a `.env` file in the deployment directory with the following variables:

```
# Database
DB_PASSWORD=strong-database-password

# Ethereum RPC URLs (at least 3 recommended)
ETHEREUM_RPC_URL_1=https://eth-sepolia.g.alchemy.com/v2/your-api-key
ETHEREUM_RPC_URL_2=https://sepolia.infura.io/v3/your-api-key
ETHEREUM_RPC_URL_3=https://rpc.ankr.com/eth_sepolia/your-api-key

# Monitoring
GRAFANA_PASSWORD=strong-grafana-password

# Circuit Breaker Configuration
MAX_GAS_PRICE_GWEI=100
CIRCUIT_BREAKER_PROVIDER_FAILURES=5
```

## Secure Key Management

For production, we recommend using a Hardware Security Module (HSM) or a secure key management service for the relayer wallet. For this setup, we're using Docker secrets:

1. Create a directory for secrets:

```bash
mkdir -p ./deployment/secrets
```

2. Add your relayer private key (without the 0x prefix):

```bash
echo "your-private-key-without-0x-prefix" > ./deployment/secrets/relayer_private_key.txt
```

## Deployment Steps

1. **Build and start the services**:

```bash
cd deployment
docker-compose up -d
```

2. **Verify services are running**:

```bash
docker-compose ps
```

3. **Check logs for any errors**:

```bash
docker-compose logs -f
```

## Load Balancing Configuration

The NGINX configuration (`nginx.conf`) provides:

- SSL termination
- Request distribution among relayer instances
- Rate limiting to prevent abuse
- Path-based security rules

To customize:
- Update the server name to match your domain
- Adjust rate limits based on expected traffic
- Update SSL certificate paths

## Monitoring Setup

### Metrics Collection

Prometheus is configured to scrape metrics from all relayer instances every 10 seconds.

### Dashboards

The Grafana dashboard (`grafana-dashboard.json`) includes panels for:
- Transaction rates and status
- Gas prices
- API request rates
- Provider health
- System resource usage
- Webhook delivery status
- Circuit breaker status

Access Grafana at `http://your-server-ip:3001` with the credentials:
- Username: admin
- Password: (from your .env file)

### Alerting

We've configured alerts for:
- Service availability
- High resource usage
- Transaction processing anomalies
- Provider failures
- Database connectivity issues
- Circuit breaker activation

Alerts can be sent to:
- Slack channels (configured per severity)
- Email
- PagerDuty (for critical alerts)

To customize alert destinations, edit `alertmanager.yml`.

## Advanced Rate Limiting

The relayer implements a tiered rate-limiting system:

- IP-based rate limiting for all requests
- User-based rate limiting with tiers (default, premium, unlimited)
- Endpoint-specific limits (stricter for sensitive operations)

To define user tiers, implement the `getUserTier` method in your `DatabaseService`.

## Scaling Considerations

The current setup supports horizontal scaling:

- To add more relayer instances, update the `docker-compose.yml` file
- To scale vertically, adjust the resource limits in the `deploy` section

## Security Practices

- Requests are validated with signature verification
- Admin endpoints are restricted by IP
- Rate limiting prevents abuse
- Circuit breaker automatically pauses the service under abnormal conditions
- Private keys are stored securely using Docker secrets

## Routine Maintenance

1. **Database Backups**: Set up daily PostgreSQL backups
2. **Log Rotation**: Ensure logs are rotated to prevent disk space issues
3. **SSL Certificate Renewal**: Set up automatic renewal for SSL certificates

## Troubleshooting

### Common Issues

1. **Unable to connect to Ethereum nodes**:
   - Check network connectivity
   - Verify API keys in environment variables
   - Check provider status in Grafana dashboard

2. **High transaction failure rate**:
   - Check gas price settings
   - Verify relayer wallet balance
   - Review transaction errors in logs

3. **Rate limiting too aggressive**:
   - Adjust limits in the rate limiter configuration
   - Increase Redis memory allocation

## Disaster Recovery

1. **Backup Strategy**:
   - Database: Daily automated backups
   - Configuration: Version controlled
   - Transaction logs: Archived daily

2. **Recovery Process**:
   - Restore database from backup
   - Deploy using configuration from version control
   - Verify system integrity with health checks

## Frequently Asked Questions

**Q: How do I add a new relayer instance?**  
A: Add a new service section in `docker-compose.yml` following the pattern of existing relayer services.

**Q: How do I update the relayer without downtime?**  
A: Use rolling updates by updating one instance at a time while the others remain available.

**Q: How do I monitor relayer wallet balance?**  
A: Add a custom metric in `metrics.js` to track wallet balance and set up an alert threshold.
