# Architecture

## System Architecture

The system follows a client-server architecture where users interact with the React frontend through a web browser. The frontend communicates with the FastAPI backend using REST APIs. The backend handles business logic, communicates with watsonx.ai for AI inference, stores and retrieves application data from PostgreSQL, and publishes relevant notifications or updates to Slack through a webhook.

flowchart TD
  graph TD A[User / Browser] -->|HTTP| B[Frontend - React] B -->|REST API| C[Backend - FastAPI] C -->|SDK / API| D[watsonx.ai] C -->|SQL Query| E[PostgreSQL] C -->|Webhook| F[Slack] D -->|AI Inference Result| C E -->|Data| C F -->|Notifications| G[Slack Users]

## Components

| Component         | Technology          | Responsibility                                                                                     |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| Frontend          | IBM Bob             | Supply chain dashboard, shipment tracking, route information, and user interaction                 |
| Application Logic | IBM Bob             | Managing shipment workflows, transportation data, route processing, and system orchestration       |
| AI / ML           | IBM watsonx.ai      | Predicting delays, identifying transportation risks, and providing intelligent recommendations     |
| Database          | PostgreSQL          | Storing shipment details, vehicle information, routes, delivery status, and transportation records |
| Notifications     | Slack API / Webhook | Sending alerts for shipment delays, route issues, and critical transportation events               |

## Data Flow

The system processes transportation and supply chain data from input to actionable insights and alerts.

1. Transportation data such as shipment details, source and destination, vehicle information, delivery schedules, and route details are entered through the application.
2. IBM Bob processes and organizes the transportation data based on the selected shipment or route.
3. The system analyzes the data to identify potential delivery delays, route issues, and transportation risks.
4. Relevant transportation records and analysis results are stored in the database for future reference and tracking.
5. The dashboard displays shipment status, route information, risk indicators, and recommendations to the user.
6. When a critical delay or transportation issue is detected, the system generates an alert or notification for the responsible user.

## Security Considerations

The system follows basic security practices to protect transportation data, application credentials, and user information.

* Sensitive credentials such as API keys and database credentials are stored in environment variables and are not committed to the Git repository.
* Authentication is applied to protected application features and API endpoints where required.
* Input data is validated before being processed to reduce invalid or malicious requests.
* Database access is controlled using secure credentials and parameterized queries.
* Sensitive transportation and user data is not exposed unnecessarily through frontend responses or logs.
* External services such as AI APIs and notification webhooks use securely stored credentials.
* `.env` files and other files containing secrets are excluded from version control using `.gitignore`.


## Scalability Notes

The current system is designed as a hackathon prototype but can be extended to support larger supply chain and transportation operations.

* The application can be deployed on scalable cloud infrastructure to support more users and transportation data.
* The backend can be made stateless so multiple application instances can run simultaneously behind a load balancer.
* PostgreSQL can be scaled using indexing, read replicas, and database optimization as shipment and route data increases.
* AI processing can be optimized using asynchronous processing and request queuing when the number of transportation analysis requests grows.
* Caching can be introduced for frequently requested route and shipment information to reduce database load.
* The notification system can be extended to handle alerts for multiple users, vehicles, shipments, and transportation events.

