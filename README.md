# Distributed Wagering Processor

Serviço de processamento de operações financeiras de apostas, desenvolvido com NestJS, Bun, PostgreSQL/MikroORM e filas SQS. O saldo da carteira é atualizado em conjunto com um ledger auditável; valores monetários são armazenados como `numeric(20,2)` no PostgreSQL e tratados com `Decimal` no domínio, sem conversão para `number`.

## Status e escopo

O projeto implementa o fluxo funcional do desafio: carteiras, operações de aposta, ledger, idempotência, concorrência por carteira, reconciliação, integração SQS com inbox/outbox, migrations, métricas e testes. É possível executá-lo localmente e exercitar os fluxos descritos neste README.

**Ainda não está pronto para exposição em produção.** O `ProviderAuthGuard` é intencionalmente no-op: a API não autentica nem autoriza provedores. Antes de produção, implemente OIDC/JWT e autorização por provedor, configure filas/permissões AWS e segredos reais, e execute as migrations como etapa de release. Veja [`ARCHITECTURE.md`](ARCHITECTURE.md) e [`infraestructure.md`](infraestructure.md) para detalhes e limitações.

**Escopo de validação:** os testes atuais cobrem invariantes de domínio, constraints reais do PostgreSQL, concorrência entre conexões/instâncias da aplicação, mensagens repetidas e referências fora de ordem. Eles ainda não demonstram todos os cenários pedidos pela rubrica, como múltiplos processos independentes, recuperação após crash/restart, concorrência de publishers Outbox e encaminhamento à DLQ.

## Executar localmente

Pré-requisitos: Bun 1.x, Docker Desktop com o engine Linux iniciado e Docker Compose.

```powershell
bun install
Copy-Item .env.example .env
docker compose up --build
```

O Compose sobe a API em `http://localhost:3000`, PostgreSQL, LocalStack SQS, as filas e as migrations. Mantenha esse terminal aberto enquanto testa. Para ver o estado dos containers em outro terminal:

```powershell
docker compose ps
```

Para encerrar, use `Ctrl+C` ou execute `docker compose down`. Os dados do PostgreSQL ficam no volume `pgdata`; `docker compose down -v` também apaga esse volume e os dados locais.

Verifique se o serviço está pronto:

```http
GET http://localhost:3000/health/ready
```

Resposta esperada:

```json
{
  "status": "ready",
  "dependencies": {
    "postgres": "ok",
    "sqs": "ok"
  }
}
```

Para executar somente a API fora do Docker, mantenha PostgreSQL e LocalStack ativos com `docker compose up -d postgres localstack`, configure `.env` e use `bun run start:dev`.

## Testes e verificações

```powershell
bun test
bun run test:integration
bun run build
bun run lint
```

Os testes de integração precisam de PostgreSQL. Para executá-los contra os serviços locais do Compose:

```powershell
$env:DATABASE_URL = "postgresql://wager:wager@localhost:5432/wager"
$env:SQS_ENDPOINT_URL = "http://localhost:4566"
$env:AWS_ACCESS_KEY_ID = "test"
$env:AWS_SECRET_ACCESS_KEY = "test"
bun run test:integration
```

## Testar pelo Postman

Use `http://localhost:3000` como base URL. Para requests com JSON, selecione **Body → raw → JSON**; o Postman deve enviar `Content-Type: application/json`. As rotas não exigem token no estado atual do projeto.

### Fluxo sugerido

1. **Criar carteira** — `POST /wallets`

   Não exige `Idempotency-Key`. Exemplo de body:

   ```json
   {
     "playerId": "player-1",
     "initialBalance": {
       "amount": "100.00",
       "currency": "BRL"
     }
   }
   ```

   Guarde o `id` da resposta para usar como `walletId`. Um saldo inicial positivo cria o crédito de abertura no ledger.

2. **Enviar aposta** — `POST /wagering/transactions`

   Headers:

   | Header | Valor |
   |---|---|
   | `Content-Type` | `application/json` |
   | `Idempotency-Key` | `provider-a:bet-001` |

   Body:

   ```json
   {
     "providerId": "provider-a",
     "externalTransactionId": "bet-001",
     "playerId": "player-1",
     "walletId": "COLE_AQUI_O_ID_DA_CARTEIRA",
     "roundId": "round-1",
     "gameId": "game-1",
     "kind": "BET",
     "money": {
       "amount": "25.00",
       "currency": "BRL"
     }
   }
   ```

   Uma aposta processada debita a carteira. A resposta inclui `transactionId`, `status` e o saldo associado ao resultado.

3. **Consultar a aposta** — `GET /providers/provider-a/wagering/transactions/bet-001`

   Ou consulte usando o UUID `transactionId` retornado no passo anterior: `GET /wagering/transactions/SEU_TRANSACTION_ID`. Esses GETs não exigem body nem `Idempotency-Key`. `PROCESSED` significa que a operação foi aplicada; `REJECTED` inclui um `failureCode`; `PENDING` ou `PENDING_REFERENCE` indica que ainda aguarda processamento ou uma referência.

4. **Conferir saldo e histórico**

   - `GET /wallets/SEU_WALLET_ID` consulta o saldo atual.
   - `GET /wallets/SEU_WALLET_ID/ledger` lista os lançamentos.
   - `POST /wallets/SEU_WALLET_ID/reconciliation` compara o saldo armazenado ao calculado pelo ledger; não corrige o saldo automaticamente.

5. **Testar um prêmio** — envie outro `POST /wagering/transactions`, mantendo o mesmo jogador e carteira e usando uma nova chave e novo ID externo:

   Headers: `Content-Type: application/json` e `Idempotency-Key: provider-a:win-001`.

   ```json
   {
     "providerId": "provider-a",
     "externalTransactionId": "win-001",
     "playerId": "player-1",
     "walletId": "COLE_AQUI_O_ID_DA_CARTEIRA",
     "roundId": "round-1",
     "gameId": "game-1",
     "kind": "WIN",
     "money": {
       "amount": "10.00",
       "currency": "BRL"
     }
   }
   ```

   Consulte novamente a carteira e o ledger para ver o crédito.

### Endpoints HTTP

Todas as rotas abaixo são relativas a `http://localhost:3000`. Os parâmetros `:walletId` e `:transactionId` devem ser substituídos por UUIDs reais; `providerId` e `externalTransactionId` devem corresponder exatamente aos valores usados ao enviar a operação.

| Método | Endpoint | Headers/body | Finalidade |
|---|---|---|---|
| `GET` | `/health/live` | Nenhum header especial; sem body | Verifica se o processo está vivo |
| `GET` | `/health/ready` | Nenhum header especial; sem body | Verifica PostgreSQL e SQS |
| `GET` | `/metrics` | Nenhum header especial; sem body | Métricas em formato Prometheus |
| `POST` | `/wallets` | `Content-Type: application/json`; body da carteira | Cria carteira |
| `GET` | `/wallets/:walletId` | Sem body | Consulta saldo, moeda e versão |
| `GET` | `/wallets/:walletId/ledger` | Sem body; query opcional `limit` e `cursor` | Lista lançamentos; use o `nextCursor` da resposta na próxima página |
| `POST` | `/wallets/:walletId/reconciliation` | Sem body | Compara saldo materializado e ledger |
| `POST` | `/wagering/transactions` | `Content-Type: application/json`, `Idempotency-Key: SUA_CHAVE`; body da operação | Envia uma aposta/operação |
| `GET` | `/wagering/transactions/:transactionId` | Sem body | Consulta por UUID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Sem body | Consulta pela identificação do provedor |

Somente `POST /wagering/transactions` exige `Idempotency-Key`. Use um valor exclusivo por operação lógica, por exemplo `provider-a:bet-001`, `provider-a:win-001` ou `provider-a:refund-001`. Ao repetir uma requisição por timeout ou dúvida, envie **a mesma chave e exatamente o mesmo body**. Para uma operação nova, use outra chave.

### Tipos de operação

`kind` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OPENING` é interno e não deve ser enviado pela API.

- `BET`: debita o valor; saldo insuficiente causa rejeição.
- `WIN`: credita o valor. Pode referenciar uma aposta com `referenceExternalTransactionId`.
- `LOSS`: registra a perda sem um segundo débito; a aposta já representa o débito da carteira.
- `REFUND`: reverte uma aposta processada. Exige `referenceExternalTransactionId` com o ID externo da aposta; o valor deve corresponder ao da referência.
- `ROLLBACK`: reverte uma operação processada compatível. Também exige `referenceExternalTransactionId` e respeita as regras de tipo, valor e saldo.

Para `REFUND` e `ROLLBACK`, inclua no JSON, por exemplo:

```json
"referenceExternalTransactionId": "bet-001"
```

A referência precisa pertencer ao mesmo provedor, jogador, carteira, moeda e rodada. Se uma operação referenciada ainda não chegou, a transação pode ficar `PENDING_REFERENCE` e será reavaliada pelo worker.

### Idempotência e respostas

Idempotência significa que repetir o envio da **mesma operação** não aplica o crédito ou débito novamente. A API grava a chave e um hash do conteúdo de negócio: mesma chave com mesmo conteúdo retorna o resultado original; mesma chave com conteúdo diferente retorna `409 Conflict`. O identificador externo `(providerId, externalTransactionId)` também deve ser único por operação do provedor.

Respostas principais de `POST /wagering/transactions`:

| HTTP | Significado |
|---|---|
| `200` | Operação processada, incluindo repetição idempotente de uma operação processada |
| `202` | Operação pendente, por exemplo aguardando uma referência |
| `400` | JSON/campos inválidos ou header `Idempotency-Key` ausente |
| `409` | Chave de idempotência reutilizada com outro conteúdo |
| `422` | Operação rejeitada por uma regra de negócio; veja `failureCode` |
| `503` | Falha transitória de persistência/conflito de lock após novas tentativas |

Uma resposta HTTP `200` não deve ser interpretada sem conferir o campo `status` do JSON. Para confirmar o resultado, consulte a operação pelo endpoint de GET e confira também saldo e ledger.

### Cenários para experimentar

- **Saldo insuficiente:** envie um `BET` maior que o saldo disponível. A transação fica `REJECTED` com `INSUFFICIENT_FUNDS`, sem débito no ledger.
- **Chave repetida:** reenvie a mesma operação com o mesmo `Idempotency-Key` e body. O saldo não muda novamente e a resposta identifica o replay.
- **Conflito de chave:** mantenha a chave usada, mas altere o valor ou outro campo de negócio. A API responde `409`.
- **Referência fora de ordem:** envie primeiro um `REFUND` ou `ROLLBACK` referenciando uma operação inexistente e, em seguida, envie a operação original. A transação pendente será reavaliada pelo worker.
- **Reconciliação:** após operações, chame o endpoint de reconciliação; `consistent: true` indica que o saldo bate com os lançamentos.

## SQS local

O Compose inicializa o LocalStack e as filas. O worker consome mensagens da `wager-transactions.fifo`, encaminha-as ao mesmo caso de uso da API e só confirma a mensagem depois do commit no banco. Mensagens com erro podem ser tentadas novamente e, depois de cinco entregas, encaminhadas para `wager-transactions-dlq.fifo`. Eventos financeiros são registrados na outbox e publicados em `wager-events.fifo` com garantia *at-least-once*; consumidores devem deduplicar por `eventId`.

## Migrations e configuração

```powershell
bun run migration:up
bun run migration:down
```

Por padrão, as migrations são aplicadas ao iniciar a aplicação local. Em produção, execute-as como etapa de release e defina `AUTO_MIGRATE=false`. Consulte `.env.example` para as variáveis de configuração.

Não coloque chaves, senhas ou tokens no Git. Para AWS, use o provider chain (SSO/role) ou Secrets Manager; configure filas, permissões e endpoints adequados ao ambiente.
