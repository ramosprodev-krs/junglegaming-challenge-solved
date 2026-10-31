# Arquitetura do Wager Processor

## 1. Objetivo

O serviço recebe operações de apostas e prêmios de provedores de jogos, aplica essas operações às carteiras dos jogadores e mantém um histórico financeiro auditável. Ele oferece duas entradas para as operações: HTTP síncrono e mensagens assíncronas por SQS. As duas entradas chamam o mesmo caso de uso de aplicação, para que uma aposta tenha as mesmas regras independentemente de como chegou.

O foco arquitetural é proteger invariantes financeiras diante de repetição de mensagens, concorrência, falhas de processo e referências que chegam fora de ordem. Para isso, as regras principais ficam no domínio e o PostgreSQL é a autoridade final de integridade e concorrência.

## 2. Organização do código

O projeto usa NestJS para composição e entrada HTTP, mas organiza as regras em camadas inspiradas em DDD:

| Diretório | Responsabilidade | Analogia com Spring |
|---|---|---|
| `src/domain` | Conceitos e regras de negócio independentes de HTTP, NestJS e banco | Classes de domínio Java, value objects e entidades de negócio |
| `src/application` | Orquestra casos de uso e transações | `@Service`/application services |
| `src/http` | Controllers, guard, health checks e tradução de erros HTTP | `@RestController`, filtros e interceptors |
| `src/infrastructure` | PostgreSQL/MikroORM, SQS e workers | Adaptadores de banco e mensageria |
| `src/migrations` | Evolução versionada do schema | Flyway/Liquibase |

O `AppModule` registra controllers e providers no container de injeção do NestJS. `main.ts` cria a aplicação, instala o filtro global de exceções e inicia o servidor.

Esta é uma aplicação DDD pragmática, não uma implementação purista de Clean Architecture: `WagerProcessorService` coordena SQL e transações diretamente com MikroORM, e não há uma camada formal de repositórios/interfaces de persistência. A separação importante aqui é manter as regras centrais em objetos de domínio (`Wallet`, `Money`, `WagerTransaction` e `WalletLedgerEntry`) em vez de espalhá-las pelos controllers ou pelo SQL.

DDD e MVC não são alternativas excludentes. Os controllers ainda cumprem um papel parecido com MVC: recebem requisições e devolvem respostas. A diferença é que as regras não são definidas pela estrutura das telas/rotas; elas são organizadas em torno do vocabulário e das regras do negócio.

## 3. Modelo de domínio

### Wallet e saldo

`Wallet` representa a carteira de um jogador em uma moeda. Ela protege operações de crédito e débito, impede moedas incompatíveis e não permite saldo negativo. Cada mudança de saldo incrementa `version`.

### Money

`Money` é um value object: valor e moeda são tratados juntos e não há setters para alterar o objeto. A entrada monetária é uma string decimal com no máximo duas casas; as operações usam `Decimal`, nunca `number` de JavaScript. Isso evita erros de ponto flutuante, como os comuns ao representar centavos com `0.1 + 0.2`.

O PostgreSQL usa `numeric(20,2)` e o domínio serializa o valor como string com duas casas. A moeda também é validada e comparações/aritmética entre moedas diferentes falham.

### WagerTransaction

`WagerTransaction` representa a operação enviada pelo provedor e controla seu ciclo de vida:

```text
PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PROCESSED, REJECTED e FAILED são estados terminais.
```

Os tipos suportados são `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OPENING` é interno e registra um saldo inicial positivo. `LOSS` é registrado como operação, mas não movimenta o saldo. `REFUND` e `ROLLBACK` precisam apontar para uma operação anterior; uma referência ainda não recebida deixa a operação em `PENDING_REFERENCE`.

### Ledger

`WalletLedgerEntry` é o lançamento imutável que registra um crédito ou débito, o valor, o saldo anterior e o posterior. Uma `LOSS` não cria lançamento porque não altera saldo. Já a carteira mantém o saldo materializado para consulta rápida; o ledger dá o histórico verificável para auditoria e reconciliação.

## 4. Fluxo de uma operação HTTP

1. `WageringController` recebe o JSON e exige o header `Idempotency-Key`.
2. `WagerProcessorService` valida os campos, normaliza `Money` e calcula um hash SHA-256 do conteúdo de negócio em formato determinístico.
3. Em uma transação PostgreSQL, insere a operação como `PENDING`. Se a chave de idempotência já existir, compara o hash: conteúdo igual é repetição segura; conteúdo diferente retorna conflito (`409`).
4. O serviço bloqueia a linha da carteira com `SELECT ... FOR UPDATE`, reconstruindo o objeto `Wallet`.
5. Valida jogador, moeda, referência, tipo e regras de saldo. Uma aposta válida debita; uma operação de prêmio válida credita. Uma falha de regra persiste a operação como `REJECTED` com seu código de falha.
6. Na mesma transação, grava o novo saldo, o lançamento do ledger, o estado/snapshot da operação e os eventos correspondentes na outbox.
7. Só depois do commit a resposta HTTP é retornada. A controller usa `200` para resultado normal, `202` para referência pendente, `422` para rejeição de regra, `409` para conflito e `400` para entrada inválida.

O uso de `balance_snapshot` significa que uma repetição pode receber o resultado/saldo associado àquela operação, sem confundir a resposta com o saldo atual após outras apostas.

## 5. Consistência, concorrência e idempotência

### Transação e bloqueio

Alterar o saldo, criar o ledger, atualizar a transação e adicionar eventos à outbox são operações atômicas no PostgreSQL. Se uma etapa falhar, o banco desfaz a transação inteira.

O bloqueio é feito por carteira, não globalmente. Duas apostas na mesma carteira são serializadas; carteiras diferentes podem ser processadas em paralelo. Em conflitos transitórios de lock/deadlock, o caso de uso tenta novamente até duas vezes; se ainda falhar, responde `503`.

### Idempotência HTTP e identidade externa

Há duas proteções relacionadas, mas distintas:

- `idempotency_key` identifica a intenção/requisição. A mesma chave e o mesmo payload de negócio podem ser repetidos sem reaplicar o movimento. A mesma chave com payload diferente resulta em conflito.
- `(provider_id, external_transaction_id)` identifica a operação do lado do provedor e não pode ser reutilizado, por constraint única no banco.

O hash inclui os campos de negócio e o dinheiro normalizado; não inclui a própria chave ou metadados de transporte.

### Integridade no banco

As regras não dependem apenas do código. A migration também cria constraints e índices para impedir carteira duplicada por jogador/moeda, saldo negativo, tipos/estados inválidos, lançamento duplicado por carteira/operação, aritmética inconsistente no ledger, referência obrigatória em reversões e reversão processada duplicada. Um trigger impede `UPDATE` e `DELETE` no ledger.

Essa duplicação intencional de garantias é uma defesa em profundidade: o domínio produz mudanças válidas, e o banco impede que bugs, concorrência ou outro caminho de escrita violem invariantes persistentes.

## 6. SQS: entrada, inbox e outbox

### Inbox e consumidor

`WorkersService` consulta a fila `wager-transactions.fifo`. Cada mensagem válida é encaminhada a `submitWager`, o mesmo caso de uso chamado pela API. A tabela `inbox_messages`, com chave `(consumer_name, message_id)`, registra mensagens já vistas na mesma transação da operação.

O worker apaga/acknowledges a mensagem SQS somente depois de `submitWager` concluir o commit. Em caso de erro, deixa a mensagem sem ack; o SQS tenta entregá-la novamente e a política de redrive pode encaminhá-la à DLQ depois de cinco entregas. A inbox evita que uma redelivery processe a mesma mensagem novamente.

### Outbox e publicação

Eventos como `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` são gravados em `outbox_messages` na mesma transação financeira. Isso evita o problema de confirmar o débito no banco e perder o evento porque o processo caiu antes de publicar na fila.

Um worker busca eventos vencidos com `FOR UPDATE SKIP LOCKED`, publica-os na `wager-events.fifo` e registra o envio. Se houver erro, agenda uma nova tentativa com backoff exponencial limitado a 300 segundos. Uma queda depois do envio à SQS e antes do registro do sucesso pode causar publicação duplicada. Portanto, a garantia é **at-least-once**, e consumidores downstream devem deduplicar usando `eventId`.

A fila FIFO ajuda com ordenação por carteira (`MessageGroupId`) e deduplicação de envio, mas não substitui as garantias transacionais/idempotentes do banco.

## 7. Referências que chegam fora de ordem

Uma reversão ou prêmio referenciado pode chegar antes da operação original. Em vez de falhar definitivamente, o sistema persiste `PENDING_REFERENCE`, registra a próxima tentativa e cria um evento. O worker verifica operações vencidas, bloqueia a transação com `SKIP LOCKED` e tenta processá-la de novo.

O intervalo cresce exponencialmente, limitado a 300 segundos. Depois de dez tentativas sem encontrar a referência, a operação é rejeitada com `REFERENCE_NOT_FOUND`. Quando há referência, o domínio/aplicação verificam que ela foi processada e corresponde ao provedor, jogador, carteira, moeda e rodada esperados. `REFUND` e `ROLLBACK` também precisam respeitar o tipo e o valor da operação original.

## 8. Persistência e migration

`Migration20261030000000` cria tabelas, constraints, índices e trigger. `entity-schemas.ts` declara os metadados/tipos das tabelas para MikroORM, mas o serviço usa SQL parametrizado nas operações críticas para deixar claros os locks, `SKIP LOCKED`, constraints e transações. As queries usam parâmetros em vez de interpolar valores recebidos.

`AUTO_MIGRATE=true` aplica migrations ao iniciar no Compose local. Em produção, a recomendação é executá-las como uma etapa de release (`bun run migration:up`) e configurar `AUTO_MIGRATE=false`, evitando que várias réplicas concorram para migrar durante o startup.

## 9. Execução local e observabilidade

`docker compose up --build` sobe PostgreSQL 16, LocalStack (SQS) e a aplicação. O script `localstack/init-sqs.sh` provisiona filas locais; o volume `pgdata` mantém o banco ao reiniciar containers. `WORKERS_ENABLED` controla os workers.

`GET /health/live` verifica se o processo está vivo; `GET /health/ready` verifica dependências necessárias; `GET /metrics` expõe métricas em formato Prometheus, incluindo estados das transações, replays idempotentes, retries, conflitos de lock, divergências de reconciliação, lag da outbox e latência p95 persistida.

Os logs de operações processadas, rejeitadas e pendentes são JSON e incluem `correlationId` (o UUID interno da transação), `messageId`, `transactionId`, `walletId` e `providerId`. Logs de falhas de infraestrutura podem ter contexto menor; não se deve assumir que todo log contém todos esses campos.

`POST /wallets/:walletId/reconciliation` compara o saldo armazenado ao total líquido dos lançamentos. Ele informa e registra divergência; não corrige o saldo silenciosamente.

## 10. Segurança e escopo

`ProviderAuthGuard` é intencionalmente no-op neste desafio. Antes de expor a API, deve ser substituído por autenticação OIDC/JWT e deve validar que a identidade autenticada pode agir pelo `providerId` enviado. Health checks e métricas permanecem públicos no código atual.

A configuração LocalStack usa credenciais fictícias de desenvolvimento. Para AWS, use IAM roles/SSO ou um gerenciador de segredos; não coloque credenciais no repositório. A integração AWS real também exige provisionamento das filas, URLs/ARNs, permissões e rede.

Fora do escopo atual estão autenticação de produção, dashboard operacional, publicação multi-região e testes de caos com encerramento do processo em pontos específicos. A suíte também não demonstra ainda múltiplos processos do sistema operacional, concorrência de publishers Outbox, redrive efetivo à DLQ nem recuperação após reinício. Os testes de integração PostgreSQL exercitam invariantes reais, inclusive entregas repetidas, concorrência entre instâncias/conexões, referências fora de ordem e isolamento entre carteiras. Eles precisam de `DATABASE_URL`; sem ela, são ignorados.

## 11. Comparação rápida com Spring

| Este projeto | Equivalente aproximado em Spring |
|---|---|
| `@Module`, providers e injeção NestJS | `@Configuration`, componentes e container Spring |
| Controller NestJS | `@RestController` |
| `WagerProcessorService` | `@Service` de aplicação/orquestração |
| Classes em `domain` | Modelo de domínio Java; `Money` se parece com um value object |
| `EntitySchema` e migration MikroORM | Mapeamento de persistência e Flyway/Liquibase |
| `EntityManager.transactional()` | `@Transactional` |
| `SqsService` e `WorkersService` | Cliente SQS e listener/worker |
| `ApiExceptionFilter` | `@ControllerAdvice` / exception handler |

As equivalências são conceituais, não uma correspondência exata de frameworks. Em especial, a transação controla atomicidade no banco; ela não torna a publicação no SQS parte de uma transação distribuída. Inbox/outbox resolvem essa fronteira de maneira resiliente.
