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
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
   console.log('正在导航到网站...');
    // 1. 增加页面加载的超时时间，给 DDoS-Guard 足够的验证时间
    await page.goto(process.env.WEBSITE_URL, { 
        waitUntil: 'networkidle2', 
        timeout: 60000 // 增加到 60 秒
    });

    console.log('页面初步加载完成，等待通过 DDoS-Guard...');
    // 2. 【关键改动】等待登录页的邮箱输入框出现，而不是 Turnstile。
    // 这能确保我们已经通过了 DDoS-Guard 的验证。
    await page.waitForSelector('#email', { timeout: 60000 }); // 同样给足 60 秒
    
    console.log('DDoS-Guard 已通过，成功进入登录页面。');

    await page.type('#email', process.env.USERNAME);
    await page.type('#password', process.env.PASSWORD);
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

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

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
    const screenshotPath = 'login-failure.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await sendTelegramMessage(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, `*登录失败！*\n时间: ${new Date().toISOString()}\n错误: ${error.message}\n请检查 Artifacts 中的截图`);
    console.error('登录失败：', error.message);
    console.error(`截屏已保存为 login-failure.png`);
    throw error;
  } finally {
    await browser.close();
  }
}

login();
