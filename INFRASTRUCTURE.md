# Infrastructure

## Local

`docker compose up --build` sobe PostgreSQL 16, LocalStack SQS e o serviço NestJS. O script `localstack/init-sqs.sh` provisiona:

| Fila | Tipo | Uso |
|---|---|---|
| `wager-transactions.fifo` | FIFO | Operações de entrada |
| `wager-transactions-dlq.fifo` | FIFO | Poison messages após 5 entregas |
| `wager-events.fifo` | FIFO | Eventos publicados pela outbox |

O consumidor agrupa por wallet no publisher de eventos e confirma a mensagem de entrada após commit. O volume Docker `pgdata` mantém o banco entre reinicializações. `AUTO_MIGRATE=true` aplica migrations no startup local.

## AWS necessária para um ambiente real

O repositório não contém nem precisa receber credenciais AWS. Para apontar esta aplicação para uma conta, configure os recursos e informe **valores não secretos**:

1. **Conta/ambiente e região AWS** (por exemplo, conta de sandbox e `sa-east-1`), nome do ambiente (`dev`, `staging`) e URL/ARN das três filas. Se as URLs não forem fornecidas, configure `AWS_ACCOUNT_ID` para derivá-las dos nomes padrão do projeto.
2. **Configuração SQS**: nomes finais, FIFO habilitado, `MessageGroupId` por wallet, política de redrive para a DLQ (número de entregas e retenção), visibility timeout e, se exigida, chave KMS.
3. **Identidade IAM**: ARN do role assumido pela aplicação, forma de autenticação (ECS task role, EKS IRSA, EC2 instance profile ou AWS SSO local) e confirmação de permissões de `ReceiveMessage`, `DeleteMessage`, `SendMessage` e `GetQueueAttributes` nas filas. Provisionamento de filas deve usar uma identidade/deploy pipeline separada.
4. **Rede**: onde o serviço será executado (ECS/EKS/EC2/outro), VPC, subnets, security groups e se haverá endpoint privado de SQS; também região/endpoint PostgreSQL e requisito de TLS.
5. **Banco**: endpoint/porta/nome lógico e modo de acesso (RDS/Aurora, usuário via Secrets Manager ou autenticação IAM). Não envie senha.
6. **Observabilidade e retenção**: destino de logs, política de retenção da DLQ, alarmes esperados e limites operacionais para lag/retries.

Não compartilhe `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, session tokens, senhas, conteúdo do `.env` ou credenciais de usuário nesta conversa nem em commits. Use AWS SSO/role e injete secrets pelo gerenciador do ambiente. Se as filas já existirem, basta fornecer seus queue URLs/ARNs e os parâmetros de rede/IAM; não é necessário conceder acesso administrativo à conta.

## Variáveis

As variáveis completas estão em `.env.example`. Para AWS, as essenciais são `AWS_REGION`, `AWS_ACCOUNT_ID` (se não passar queue URLs), `SQS_TRANSACTION_QUEUE_URL`, `SQS_EVENT_QUEUE_URL` e `SQS_DEAD_LETTER_QUEUE_URL`. Omitir `SQS_ENDPOINT_URL` ativa a cadeia padrão de credenciais da AWS SDK; em local use `http://localhost:4566`.

As migrations são executadas em etapa de release (`bun run migration:up`); em réplicas de produção, configure `AUTO_MIGRATE=false` para evitar que cada instância tente migrar durante o startup.
