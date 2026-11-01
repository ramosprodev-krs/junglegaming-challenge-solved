# Arquitetura do Wager Processor

## Objetivo e escopo

O serviço recebe operações financeiras de provedores de jogos, aplica seus efeitos às carteiras e mantém um histórico auditável. Há duas entradas: API HTTP e mensagens SQS. Ambas chamam o mesmo caso de uso (`WagerProcessorService`) e persistem em PostgreSQL.

O desenho prioriza precisão monetária, idempotência persistente, concorrência por carteira, ledger e recuperação de mensagens. A autenticação foi deixada de fora conforme permitido pelo desafio. O `ProviderAuthGuard` é um ponto de extensão no-op; esta aplicação não deve ser exposta a tráfego não confiável antes de integrar um IdP OIDC/JWT e autorização por provedor.

## Estrutura e responsabilidades

| Área | Responsabilidade |
|---|---|
| `src/domain` | Regras independentes de HTTP, banco e NestJS: `Money`, `Wallet`, transações, ledger, inbox/outbox e eventos |
| `src/application` | Casos de uso, transações PostgreSQL, validação, consultas, reconciliação e métricas |
| `src/http` | Controllers, guard e tradução de erros para HTTP |
| `src/infrastructure` | MikroORM, schema de persistência, AWS SDK SQS e workers |
| `src/migrations` | Schema versionado e reversível |

O NestJS faz a composição por módulos, controllers, providers e injeção de dependência. O desenho é DDD pragmático: regras centrais estão em objetos do domínio, mas `WagerProcessorService` também coordena SQL parametrizado diretamente. Não há repositório formal para cada agregado. Isso reduz indirection e deixa locks e constraints visíveis, ao custo de um application service mais acoplado à persistência.

## Decisões técnicas e justificativas

| Decisão | Motivo e garantia | Custo ou limite |
|---|---|---|
| `Decimal` no domínio, string nos contratos e `numeric(20,2)` no PostgreSQL | Evita erros de ponto flutuante em operações financeiras. O formato de entrada aceita string decimal não negativa com até duas casas; a moeda é validada como código de três letras maiúsculas. | A validação verifica o formato da moeda, não consulta uma lista completa de códigos ISO. |
| Lock pessimista por linha da carteira (`SELECT ... FOR UPDATE`) | Serializa alterações concorrentes na mesma carteira sem usar lock global. O banco também impõe saldo não negativo. | Uma carteira muito disputada é serializada; conflitos transitórios são repetidos um número limitado de vezes. |
| Transação PostgreSQL para operação, saldo, ledger e outbox | Ou todos esses registros são confirmados, ou nenhum é. A API só produz o resultado depois do commit. | A chamada ao SQS pelo publisher da outbox acontece enquanto uma transação e locks estão abertos; indisponibilidade/lentidão do broker pode prolongá-los. |
| Idempotência persistida por chave e hash do conteúdo de negócio | Uma repetição com chave e conteúdo iguais retorna o resultado existente sem repetir o movimento; reutilizar a chave com conteúdo diferente gera conflito. | A garantia depende da persistência PostgreSQL, não de cache nem somente da deduplicação FIFO do SQS. |
| Identidade externa única por `(provider_id, external_transaction_id)` | Impede que o mesmo provedor reutilize a identidade de uma operação. É uma proteção distinta da chave de idempotência. | O integrador precisa manter IDs estáveis e únicos por provedor. |
| Saldo materializado mais ledger imutável | Saldo rápido para leitura; lançamentos de crédito/débito explicam sua evolução. Uma reconciliação compara o saldo ao líquido do ledger. | A reconciliação detecta e informa divergências, não as corrige automaticamente. `LOSS` não muda saldo e, portanto, não cria lançamento. |
| Inbox e Outbox em PostgreSQL com SQS at-least-once | Inbox registra mensagens de entrada; outbox guarda eventos na mesma transação financeira para que um crash não perca o evento confirmado. | Publicação duplicada ainda é possível se o processo cair após o SQS aceitar a mensagem e antes de marcar a outbox como publicada. Consumidores devem deduplicar por `eventId`. |
| Retry de referência com backoff | Permite receber `REFUND`, `ROLLBACK` ou `WIN` referenciado antes da operação original, sem rejeitá-lo de imediato. | Há limite de dez tentativas para referências; depois disso, a transação é rejeitada com `REFERENCE_NOT_FOUND`. |
| MikroORM com SQL parametrizado nos trechos críticos | Mantém configuração/conexões e transações integradas ao NestJS, enquanto SQL torna explícitos `FOR UPDATE`, `SKIP LOCKED` e `ON CONFLICT`. | Exige cuidado manual com mapping, queries e serialização dos tipos do banco. |
| Autenticação fora do escopo | A seção 2 do desafio permite um guard no-op desde que a decisão, o ponto de extensão e o desenho futuro sejam documentados. | O guard atual permite todas as requisições. O serviço não está protegido para produção. |

## Modelo de domínio

### Dinheiro e carteira

`Money` é um value object imutável de valor e moeda. A aritmética usa `Decimal`; operações entre moedas incompatíveis falham. O PostgreSQL armazena valores em `numeric(20,2)`. Contratos HTTP usam `{ "amount": "25.00", "currency": "BRL" }`, nunca número JSON.

`Wallet` encapsula saldo e versão. `open` cria versão 1 e, quando o saldo inicial é positivo, cria também a transação interna `OPENING` e o lançamento `CREDIT`. `debit` e `credit` validam moeda e valor, criam o lançamento antes de atualizar o saldo e incrementam a versão quando o saldo muda. A unicidade de carteira por jogador/moeda e o saldo não negativo também são protegidos por constraints no banco.

### Operação e ledger

`WagerTransaction` guarda a identidade interna/externa, provedor, valor, estado e eventual referência. Estados:

```text
PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PROCESSED, REJECTED e FAILED são terminais.
```

Tipos externos: `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. `OPENING` é interno. `BET` debita; `WIN` credita; `LOSS` registra resultado sem novo movimento; `REFUND` credita uma aposta elegível; `ROLLBACK` inverte a direção da transação referenciada. Reversões exigem referência processada compatível e não podem ser aplicadas mais de uma vez segundo as constraints/regras da aplicação.

`WalletLedgerEntry` é imutável e verifica a relação entre saldo anterior, direção, valor e saldo posterior. A migration também impede atualização/exclusão e duplicação de lançamentos para uma operação/carteira.

## Fluxo HTTP e idempotência

1. `WageringController` recebe o JSON e exige `Idempotency-Key`.
2. O serviço valida campos e valor, normaliza `Money` e calcula SHA-256 sobre os campos de negócio serializados de forma determinística; a chave e metadados de transporte não entram no hash.
3. Na transação PostgreSQL, tenta registrar a operação. Se a chave já existe, compara o hash: igual é replay; diferente é conflito HTTP `409`.
4. Bloqueia a linha da carteira com `SELECT ... FOR UPDATE`, reidrata o agregado e aplica as regras de saldo/moeda/referência.
5. Persiste estado, saldo, ledger e eventos de outbox na mesma transação. Uma rejeição de regra é persistida como `REJECTED` com `failureCode` e sem movimento.
6. Após o commit, devolve o resultado. O `balance_snapshot` é o saldo associado à operação, não necessariamente o saldo atual depois de operações posteriores.

Na rota de submissão, os estados devem ser interpretados junto do status HTTP: `PROCESSED` é resultado aplicado; `REJECTED` informa `failureCode`; `PENDING`/`PENDING_REFERENCE` indica trabalho ainda não concluído. A implementação usa `200` para resultado normal/replay, `202` para pendência, `422` para rejeição de negócio, `409` para conflito, `400` para entrada inválida e `503` para conflito transitório de lock não resolvido.

## Concorrência e integridade

O PostgreSQL é a autoridade final. `SELECT ... FOR UPDATE` serializa alterações à mesma carteira. Carteiras diferentes podem avançar em paralelo. Em conflito de lock/deadlock, o serviço tenta novamente até duas vezes; se não resolver, devolve `503`.

A migration complementa as regras da aplicação com constraints e índices para unicidade de carteira por jogador/moeda, saldo não negativo, tipos/estados válidos, chave de idempotência, identidade externa, referência obrigatória e reversão processada única. O ledger tem verificação aritmética, unicidade e trigger que bloqueia `UPDATE`/`DELETE`. A intenção é defesa em profundidade: um novo caminho de escrita também encontra as invariantes no banco.

## SQS, Inbox e Outbox

`WorkersService` recebe mensagens de `wager-transactions.fifo` e encaminha o payload a `submitWager`, o mesmo caso de uso da API. O registro de inbox usa `(consumer_name, message_id)` e é gravado junto à operação. O worker dá ack depois que o caso de uso termina; erros não confirmados ficam sujeitos à redelivery e à política de redrive para `wager-transactions-dlq.fifo` após cinco entregas.

Eventos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` são gravados na outbox com a alteração financeira. O publisher usa `FOR UPDATE SKIP LOCKED`, publica em `wager-events.fifo` e marca o evento como publicado. Em falha agenda retry exponencial limitado a 300 segundos. Uma queda entre envio e marcação pode publicar duplicado; a garantia é at-least-once, não exactly-once.

**Trade-off a acompanhar:** o publisher mantém uma transação e locks enquanto faz a chamada de rede ao SQS. Isso é simples e permite que `SKIP LOCKED` distribua eventos entre publishers, mas pode segurar conexões/locks durante lentidão do broker. Uma evolução possível é reservar eventos por lease/claim em uma transação curta, publicar fora dela e marcar o resultado depois. Essa mudança exige novo tratamento de lease expirado e duplicatas; deve ser feita e testada, não presumida como melhoria sem risco.

## Migrations, configuração e observabilidade

`Migration20261030000000` cria tabelas, índices, constraints e trigger. `AUTO_MIGRATE=true` aplica migrations no Compose local. Em produção, execute `bun run migration:up` como etapa de release e defina `AUTO_MIGRATE=false`.

O Compose sobe PostgreSQL 16, LocalStack SQS e API. `localstack/init-sqs.sh` provisiona filas FIFO e DLQ. Para AWS, use IAM roles/SSO ou Secrets Manager; não armazene credenciais no repositório.

`GET /health/live` verifica o processo; `/health/ready` verifica PostgreSQL e SQS; `/metrics` expõe métricas Prometheus, incluindo estados, replays, retries, conflitos de lock, divergências de reconciliação, lag da outbox e latência p95. Logs JSON de operações carregam `correlationId` (UUID interno da transação), `transactionId`, `walletId`, `providerId` e, quando disponível, `messageId`. Logs gerais de infraestrutura podem ter contexto menor.

## Testes, cobertura e limitações

Com PostgreSQL e LocalStack locais, os testes de integração cobrem constraints reais, redelivery SQS, 50 submissões duplicadas, duas apostas concorrentes na mesma carteira, carteiras distintas e referência que chega fora de ordem. Os três objetos `WagerProcessorService` do teste de concorrência usam conexões ORM separadas no mesmo processo; isso testa concorrência real no banco, mas não equivale a três processos do sistema operacional.

Na execução de validação mais recente, `bun run test:integration` passou com 10 testes e `bun test` passou com 75 testes de domínio; sem as variáveis de ambiente de integração, os testes de integração são ignorados. Também passaram `bun run build` e `bun run lint`.

Ainda não há testes explícitos de crash/restart entre commit e ack, redrive efetivo à DLQ, dois publishers independentes disputando a mesma outbox ou três processos separados. A rubrica pede esses cenários. Também vale ampliar casos de negócio específicos de `REFUND`/`ROLLBACK` e alinhar o tipo/nome das métricas Prometheus ao significado efetivo. A ausência desses testes não deve ser apresentada como garantia comprovada.

## Referência a Spring Boot

As equivalências são conceituais: `@Module`/providers e injeção NestJS lembram configuração e beans Spring; controllers lembram `@RestController`; `WagerProcessorService` lembra um serviço de aplicação; o filtro de exceção lembra `@ControllerAdvice`; migrations lembram Flyway/Liquibase; e o `EntityManager.transactional()` do MikroORM oferece atomicidade semelhante a `@Transactional`. Nenhuma dessas equivalências implica que os frameworks tenham o mesmo ciclo de vida ou API.

Uma transação de banco não é uma transação distribuída com SQS. Inbox/Outbox tratam essa fronteira com persistência local e entrega at-least-once.
