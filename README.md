🌐 DertoWeb Child Panel

Welcome to DertoWeb Child Panel! 🎮

This guide will help you deploy your Child Panel, connect it to your Main Panel, connect your Minecraft server, and configure your payment gateway.

Follow each step carefully to get your webstore fully operational.

---

📚 Table of Contents

Click any section below to jump directly to that step.

1. "🚀 Deploy Child Panel on Render" (#1--deploy-child-panel-on-render)
2. "🔗 Connect Child Panel to Main Panel" (#2--connect-child-panel-to-main-panel)
3. "🎮 Connect Your Minecraft Server" (#3--connect-your-minecraft-server)
4. "💳 Configure Payment Gateway" (#4--configure-payment-gateway)
5. "✅ Final Setup Checklist" (#5--final-setup-checklist)

---

1. 🚀 Deploy Child Panel on Render

In this step, you will deploy your DertoWeb Child Panel using Render.

📌 Step 1: Get the source code

- Copy the GitHub repository link of your DertoWeb Child Panel source code.

📌 Step 2: Create or log in to Render

- Visit "Render" (https://render.com/).
- If you are a new user, create an account.
- If you already have an account, simply log in.

📌 Step 3: Create a Web Service

1. Click the ➕ Plus icon.
2. Select New Web Service.
3. Paste your Child Panel GitHub repository link.
4. Click Connect.
5. Select the ₹0 plan.
6. Click Deploy.

📌 Step 4: Open your Child Panel

- ⏳ Wait approximately 1 minute for deployment.
- Once deployment is complete, your website URL will appear in the Render console.
- Click the URL to open your Child Panel.

🎉 Your Child Panel is now deployed!

---

2. 🔗 Connect Child Panel to Main Panel

In this step, you will connect your Child Panel to your DertoWeb Main Panel.

📌 Step 1: Generate a Connect Code

- Open your DertoWeb Main Panel.
- Generate a Connect Code for your Child Panel.
- Copy the generated code.

📌 Step 2: Complete Child Panel setup

- Open your deployed Child Panel website.
- Paste the Connect Code into the setup code field.
- Set your administrator password.
- Click Connect.

✅ Your Child Panel is now connected to your Main Panel.

---

3. 🎮 Connect Your Minecraft Server

Connect your Minecraft server to the Child Panel so your webstore can deliver purchases in-game.

📌 Step 1: Download the official plugin

Download the official DertoWeb Minecraft plugin:

🔗 Plugin Download: https://bit.ly/3XrXAR6

📌 Step 2: Install the plugin

1. Open your Minecraft server files.
2. Navigate to the "plugins" folder.
3. Upload the DertoWeb plugin ".jar" file.
4. Restart your Minecraft server once.

📌 Step 3: Generate a Pairing Code

1. Open your DertoWeb Child Panel.
2. Go to the Admin Page.
3. Navigate to Minecraft Connection.
4. Click Generate Pairing Code.
5. Copy the generated pairing code.
6. Copy your Child Panel website URL.

📌 Step 4: Configure the plugin

1. Open your Minecraft server's "plugins" folder.
2. Open the "DertoWeb" folder.
3. Open the "config.yml" file.
4. Add your Child Panel URL and pairing code.

Example configuration:

panel-url: "YOUR_CHILD_PANEL_URL"
pairing-code: "YOUR_PAIRING_CODE"

🔧 Replace the example values with your actual Child Panel URL and pairing code.

5. Save the configuration file.
6. Restart your Minecraft server.

🎉 Your Minecraft server is now connected to your Child Panel!

---

4. 💳 Configure Payment Gateway

In this step, you will configure your FamPay UPI details and Gmail App Password.

📌 Step 1: Get your FamPay information

Prepare the following details:

- 💰 Your FamPay UPI ID
- 📧 The email address connected to your FamPay account

📌 Step 2: Generate a Gmail App Password

1. Open the official Google App Passwords page:
   
   🔗 https://myaccount.google.com/apppasswords

2. Sign in to your Gmail account.

3. Enter the app name:
   
   "webpanel"

4. Click Create.

5. Google will generate a 16-digit App Password.

6. Copy the generated password.

⚠️ Security Tip: Keep your App Password private. Never share it publicly or upload it to GitHub.

📌 Step 3: Configure the payment gateway

1. Open your DertoWeb Child Panel.

2. Navigate to Payment Gateway Setup.

3. Enter the following information:
   
   - 💰 FamPay UPI ID
   - 📧 FamPay connected email
   - 🔑 Gmail App Password

4. Click Save.

✅ Your payment gateway setup is complete!

---

5. ✅ Final Setup Checklist

Before launching your webstore, make sure everything is configured correctly.

- [ ] 🚀 Child Panel deployed successfully on Render
- [ ] 🔗 Child Panel connected to Main Panel
- [ ] 🔐 Administrator password configured
- [ ] 🎮 Official Minecraft plugin installed
- [ ] 🔌 Minecraft server connected using pairing code
- [ ] 💳 Payment gateway configured
- [ ] 📧 Gmail App Password saved successfully

---

🎉 Congratulations!

Your DertoWeb Child Panel is now deployed and configured.

You are ready to:

- 🛍️ Manage your webstore catalog
- 📦 Manage customer orders
- 💳 Receive payments
- 🎮 Deliver purchases directly to your Minecraft server

Thank you for using DertoWeb!

Happy selling! 🚀
