# Infraestrutura

## Ambiente local

`docker compose up --build` sobe PostgreSQL 16, LocalStack SQS e o serviço NestJS. O script `localstack/init-sqs.sh` provisiona:

| Fila | Tipo | Uso |
|---|---|---|
| `wager-transactions.fifo` | FIFO | Operações de entrada |
| `wager-transactions-dlq.fifo` | FIFO | Mensagens encaminhadas após 5 entregas |
| `wager-events.fifo` | FIFO | Eventos publicados pela outbox |

O consumidor agrupa por wallet no publisher de eventos e confirma a mensagem de entrada após commit. O volume Docker `pgdata` mantém o banco entre reinicializações. `AUTO_MIGRATE=true` aplica migrations no startup local.

## AWS para um ambiente real

O repositório não contém nem precisa receber credenciais AWS. Para apontar esta aplicação para uma conta, configure os recursos e informe **valores não secretos**:

1. **Conta/ambiente e região AWS** (por exemplo, conta de sandbox e `sa-east-1`), nome do ambiente (`dev`, `staging`) e URL/ARN das três filas. Se as URLs não forem fornecidas, configure `AWS_ACCOUNT_ID` para derivá-las dos nomes padrão do projeto.
2. **Configuração SQS**: nomes finais, FIFO habilitado, `MessageGroupId` por carteira, política de redrive para a DLQ (número de entregas e retenção), tempo de visibilidade e, se exigida, chave KMS.
3. **Identidade IAM**: ARN da função assumida pela aplicação, forma de autenticação (função de tarefa ECS, EKS IRSA, perfil de instância EC2 ou AWS SSO local) e confirmação das permissões `ReceiveMessage`, `DeleteMessage`, `SendMessage` e `GetQueueAttributes` nas filas. O provisionamento deve usar uma identidade ou pipeline de implantação separado.
4. **Rede**: onde o serviço será executado (ECS/EKS/EC2/outro), VPC, sub-redes, grupos de segurança e uso de endpoint privado do SQS; informe também a região/endpoint PostgreSQL e a exigência de TLS.
5. **Banco**: endpoint/porta/nome lógico e modo de acesso (RDS/Aurora, usuário via Secrets Manager ou autenticação IAM). Não envie senha.
6. **Observabilidade e retenção**: destino dos logs, retenção da DLQ, alarmes esperados e limites operacionais para atraso e novas tentativas.

Não compartilhe `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, tokens de sessão, senhas, conteúdo do `.env` ou credenciais de usuário nesta conversa nem em commits. Use AWS SSO/funções IAM e injete segredos pelo gerenciador do ambiente. Se as filas já existirem, forneça suas URLs/ARNs e os parâmetros de rede/IAM; não é necessário conceder acesso administrativo à conta.

## Variáveis de ambiente

As variáveis estão em `.env.example`. Para AWS, as principais são `AWS_REGION`, `AWS_ACCOUNT_ID` (se não informar as URLs das filas), `SQS_TRANSACTION_QUEUE_URL`, `SQS_EVENT_QUEUE_URL` e `SQS_DEAD_LETTER_QUEUE_URL`. Sem `SQS_ENDPOINT_URL`, o SDK usa a cadeia padrão de credenciais da AWS; localmente, use `http://localhost:4566`.

Execute as migrations na etapa de publicação (`bun run migration:up`). Em produção, configure `AUTO_MIGRATE=false` para evitar que cada instância tente migrar durante a inicialização.
