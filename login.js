const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

async function sendTelegramMessage(botToken, chatId, message) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'  // 可选：支持格式化
  }).catch(error => {
    console.error('Telegram 通知失败:', error.message);
  });
}

async function solveTurnstile(page, sitekey, pageUrl) {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) throw new Error('CAPTCHA_API_KEY 未设置');

  const submitTaskRes = await axios.post('http://2captcha.com/in.php', {
    key: apiKey,
    method: 'turnstile',
    sitekey: sitekey,
    pageurl: pageUrl,
    json: 1
  });

  if (submitTaskRes.data.status !== 1) {
    throw new Error(`提交任务失败: ${submitTaskRes.data.request}`);
  }

  const taskId = submitTaskRes.data.request;

  let result;
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(5000);
    const getResultRes = await axios.get(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
    if (getResultRes.data.status === 1) {
      result = getResultRes.data.request;
      break;
    }
    if (getResultRes.data.request === 'CAPCHA_NOT_READY') {
      continue;
    }
    throw new Error(`获取结果失败: ${getResultRes.data.request}`);
  }

  if (!result) throw new Error('Turnstile 解决超时');

  await page.evaluate((token) => {
    const textarea = document.querySelector('textarea[name="cf-turnstile-response"]');
    if (textarea) {
      textarea.value = token;
    } else {
      if (window.turnstileCallback) {
        window.turnstileCallback({ token });
      }
    }
  }, result);

  console.log('Turnstile 已解决');
}

async function login() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled', // 额外隐藏自动化特征
      '--window-size=1920,1080' // 设置窗口大小，避免默认视窗被检测
    ]
  });
  const page = await browser.newPage();
  
  // 1. 设置更真实的 UA
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // 2. 【核心修复】注入 Cookies
  if (process.env.COOKIES_JSON) {
    try {
      const cookies = JSON.parse(process.env.COOKIES_JSON);
      // 过滤掉可能导致问题的属性，只要核心数据
      const validCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expirationDate // Puppeteer 使用 expires, EditThisCookie 使用 expirationDate
      }));
      await page.setCookie(...validCookies);
      console.log('✅ 成功注入 Cookies，尝试绕过 Cloudflare...');
    } catch (e) {
      console.error('❌ Cookies 注入失败:', e.message);
    }
  }

  try {
    console.log('正在导航到网站...');
    await page.goto(process.env.WEBSITE_URL, { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
    });

    // 3. 处理 Cloudflare 拦截页面
    // 检查页面标题是否包含 Cloudflare 的特征
    const pageTitle = await page.title();
    console.log(`当前页面标题: ${pageTitle}`);

    if (pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare')) {
        console.log('⚠️ 检测到 Cloudflare 验证页面，尝试等待...');
        // 如果有 cookies，这里通常会直接跳转。如果没有，这里等待 10 秒看是否通过
        await page.waitForTimeout(10000); 
    }

    console.log('检查是否到达登录页...');
    
    // 使用 try-catch 包裹 waitForSelector，以便在超时时截图调试
    try {
        await page.waitForSelector('#email', { timeout: 30000 });
    } catch (e) {
        throw new Error('未找到邮箱输入框，可能仍被 Cloudflare 拦截 (Check login-failure.png)');
    }
    
    console.log('DDoS-Guard/Cloudflare 已通过，成功进入登录页面。');

    await page.type('#email', process.env.USERNAME, { delay: 100 }); // 加入输入延迟，模拟人类
    await page.type('#password', process.env.PASSWORD, { delay: 100 });
    
    console.log('正在查找 Cloudflare Turnstile...');
    
     // 3. 现在可以安全地等待 Turnstile 元素
    await page.waitForSelector('.cf-turnstile', { timeout: 15000 });

    const sitekey = await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile');
      return el ? el.dataset.sitekey : null;
    });

    if (!sitekey) throw new Error('未找到 Turnstile sitekey');
    
    console.log('找到 Sitekey，正在请求 2Captcha 解决...');
    const currentUrl = page.url();
    await solveTurnstile(page, sitekey, currentUrl);
    
    console.log('Turnstile 已解决，准备提交登录...');
    await page.waitForTimeout(1000); // 短暂等待，确保 token 注入

    await page.click('button[type="submit"]');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    const currentUrlAfter = page.url();
    const title = await page.title();

    if (currentUrlAfter.includes('/') && !title.includes('Login')) {
      await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, `*登录成功！*\n时间: ${new Date().toISOString()}\n页面: ${currentUrlAfter}\n标题: ${title}`);
      console.log('登录成功！当前页面：', currentUrlAfter);
    } else {
      throw new Error(`登录可能失败。当前 URL: ${currentUrlAfter}, 标题: ${title}`);
    }

    console.log('脚本执行完成。');
} catch (error) {
    // ... 报错处理代码保持不变 ...
    const screenshotPath = 'login-failure.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    // ...
    throw error;
  } finally {
    await browser.close();
  }
}

login();
